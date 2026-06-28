import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const BUILTIN_ROLE_IDS = new Set(["reviewer", "security", "debugger", "architecture", "reliability-perf"]);
const TOPICS = [
  {
    roleId: "reviewer",
    title: "Reviewer",
    summary: "General code review, regressions, missing tests, and correctness gaps.",
    triggerHints: ["test", "validation", "regression", "coverage", "review", "lint"],
    body: [
      "Reviews compact board evidence for regressions, missing tests, validation gaps, and correctness issues.",
      "- Focus on the smallest actionable fix.",
      "- Prefer grounded evidence over speculation.",
      "- Do not request or perform edits.",
    ].join("\n"),
  },
  {
    roleId: "security",
    title: "Security",
    summary: "Secrets, auth, permissions, and data-loss risks.",
    triggerHints: ["auth", "secret", "token", "permission", "threat"],
    body: [
      "Reviews compact board evidence for secrets, auth, permission, and data-loss risks.",
      "- Flag only material security concerns.",
      "- Prefer precise risky paths and evidence pointers.",
      "- Do not request or perform edits.",
    ].join("\n"),
  },
  {
    roleId: "debugger",
    title: "Debugger",
    summary: "Failures, stack traces, retries, and repetitive loops.",
    triggerHints: ["failure", "crash", "stack", "trace", "timeout", "loop"],
    body: [
      "Triages failures, stack traces, retries, and repetitive loops from compact board evidence.",
      "- Focus on failure chains and the most likely next check.",
      "- Treat loop-like behavior as a reliability signal, not a new policy layer.",
      "- Do not request or perform edits.",
    ].join("\n"),
  },
  {
    roleId: "architecture",
    title: "Architecture",
    summary: "Design shape, decomposition, API boundaries, and refactor direction.",
    triggerHints: ["refactor", "api", "design", "boundary", "abstraction"],
    body: [
      "Reviews design shape, decomposition, API boundaries, and refactor direction.",
      "- Prefer durable structure over one-off fixes.",
      "- Call out abstraction leaks and unnecessary coupling.",
      "- Do not request or perform edits.",
    ].join("\n"),
  },
  {
    roleId: "reliability-perf",
    title: "Reliability and Performance",
    summary: "Timeouts, repeated failures, throughput, and cost drift.",
    triggerHints: ["timeout", "latency", "retry", "budget", "throughput", "loop"],
    body: [
      "Reviews timeouts, repeated failures, throughput, and cost drift from compact board evidence.",
      "- Focus on repeated failures, slow paths, and budget pressure.",
      "- Keep loop prevention in policy; report the evidence instead.",
      "- Do not request or perform edits.",
    ].join("\n"),
  },
];

function walkJsonlFiles(input) {
  if (!existsSync(input)) return [];
  const stat = statSync(input);
  if (stat.isFile()) return input.endsWith(".jsonl") ? [input] : [];
  const out = [];
  const stack = [input];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out.sort();
}

function readRows(file) {
  const rows = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch {}
  }
  return rows;
}

function textFromContent(content) {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return String(content ?? "").replace(/\s+/g, " ").trim();
  const parts = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") { parts.push(item); continue; }
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (typeof item.text === "string") parts.push(item.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function redacted(text) {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[abprs]|hf)[-_][A-Za-z0-9_\-]{8,}/g, "[secret]")
    .slice(0, 240);
}

function compactText(value) {
  return redacted(textFromContent(value).toLowerCase());
}

function sessionMeta(rows) {
  const first = rows.find((row) => row?.type === "session") ?? {};
  return {
    sessionId: typeof first.id === "string" && first.id.trim() ? first.id : "session",
    cwd: typeof first.cwd === "string" && first.cwd.trim() ? first.cwd : "",
  };
}

function sessionMatchesCwd(cwd, needle) {
  if (!needle) return true;
  if (!cwd) return false;
  const normalizedNeedle = resolve(needle).replace(/\\/g, "/");
  const normalizedCwd = resolve(cwd).replace(/\\/g, "/");
  const prefix = normalizedNeedle.endsWith("/") ? normalizedNeedle : `${normalizedNeedle}/`;
  return normalizedCwd === normalizedNeedle || normalizedCwd.startsWith(prefix);
}

function roleMarkdown(candidate) {
  const topic = TOPICS.find((entry) => entry.roleId === candidate.sourceRoleId);
  return [
    "---",
    `id: ${candidate.roleId}`,
    "kind: specialist",
    "version: 1",
    "enabledByDefault: false",
    "callableBy: [codriver, navigator, head-of-board]",
    "costTier: cheap",
    "allowedTools: [read, search, context_lookup]",
    "outputSchema: boardFinding.v1",
    `triggerHints: [${topic.triggerHints.join(", ")}]`,
    "maxTokens: 900",
    "---",
    `# ${topic.title}`,
    "",
    "Generated from past session metadata.",
    "",
    `- Confidence: ${candidate.confidence.toFixed(2)}`,
    `- Source sessions: ${candidate.sourceSessionIds.join(", ") || "none"}`,
    `- Matched signals: ${candidate.matchedSignals.join(", ") || "none"}`,
    "",
    topic.body,
    "",
    "This role is generated disabled-by-default and should be reviewed before use.",
  ].join("\n");
}

function generatedRoleId(sourceRoleId) {
  const id = `personal-${sourceRoleId}`;
  if (BUILTIN_ROLE_IDS.has(id)) throw new Error(`generated role id collides with built-in role id: ${id}`);
  return id;
}

function discoverPersonalSpecialists(input) {
  if (!input.allowPastSessionDiscovery) {
    return { enabled: false, skipped: "consent_required", scannedSessions: 0, candidates: [] };
  }

  const sessionRoot = resolve(input.sessionRoot || join(homedir(), ".pi", "agent", "sessions"));
  const cwdContains = input.cwdContains || "";
  const files = walkJsonlFiles(sessionRoot);
  const byRole = new Map();
  let scannedSessions = 0;
  let matchedSessions = 0;

  for (const file of files) {
    const rows = readRows(file);
    const meta = sessionMeta(rows);
    if (!sessionMatchesCwd(meta.cwd, cwdContains)) continue;
    matchedSessions += 1;
    if (input.limitSessions !== undefined && matchedSessions > input.limitSessions) break;
    scannedSessions += 1;
    const texts = [];
    for (const row of rows) {
      if (row?.type !== "message") continue;
      const msg = row.message;
      if (!msg || msg.role !== "user") continue;
      const text = compactText(msg.content);
      if (text) texts.push(text);
    }
    const sessionText = texts.join(" ");
    if (!sessionText) continue;

    for (const topic of TOPICS) {
      const hits = topic.triggerHints.filter((hint) => sessionText.includes(hint));
      if (hits.length === 0) continue;
      const record = byRole.get(topic.roleId) ?? { topic, sourceSessionIds: new Set(), matchedSignals: new Set(), hits: 0 };
      record.sourceSessionIds.add(meta.sessionId);
      hits.forEach((hit) => record.matchedSignals.add(hit));
      record.hits += hits.length;
      byRole.set(topic.roleId, record);
    }
  }

  const candidates = [...byRole.values()]
    .map((record) => {
      const sessionCount = record.sourceSessionIds.size;
      const signalCount = record.matchedSignals.size;
      const confidence = Math.min(0.95, 0.35 + 0.12 * sessionCount + 0.07 * signalCount);
      return {
        roleId: generatedRoleId(record.topic.roleId),
        sourceRoleId: record.topic.roleId,
        title: record.topic.title,
        summary: record.topic.summary,
        confidence,
        matchedSignals: [...record.matchedSignals].sort(),
        sourceSessionIds: [...record.sourceSessionIds].sort(),
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.roleId.localeCompare(b.roleId))
    .slice(0, input.limitCandidates ?? 5);

  const outputDir = resolve(input.outputDir || join(homedir(), ".pi", "agent", "pi-rogue", "specialist-discovery", new Date().toISOString().replace(/[:.]/g, "-")));
  mkdirSync(outputDir, { recursive: true });
  for (const candidate of candidates) {
    const file = join(outputDir, `${candidate.roleId.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`);
    candidate.markdownPath = file;
    writeFileSync(file, `${roleMarkdown(candidate)}\n`, "utf8");
  }

  return { enabled: true, scannedSessions, outputDir, candidates };
}

function loadSnapshot(cachePath) {
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    const result = raw.result && typeof raw.result === "object" ? raw.result : undefined;
    return {
      version: 1,
      refreshedAt: typeof raw.refreshedAt === "string" ? raw.refreshedAt : undefined,
      refreshingAt: typeof raw.refreshingAt === "string" ? raw.refreshingAt : undefined,
      lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
      result: result && Array.isArray(result.candidates) ? result : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

function saveSnapshot(cachePath, snapshot) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

const raw = process.env.PI_ROGUE_PERSONAL_SPECIALIST_REFRESH;
if (!raw) {
  throw new Error("personal specialist discovery worker requires PI_ROGUE_PERSONAL_SPECIALIST_REFRESH");
}

const input = JSON.parse(raw);
const cachePath = input.cachePath;

try {
  const result = discoverPersonalSpecialists(input);
  saveSnapshot(cachePath, {
    version: 1,
    refreshedAt: new Date().toISOString(),
    lastError: undefined,
    result,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const latest = loadSnapshot(cachePath);
  saveSnapshot(cachePath, {
    version: 1,
    refreshedAt: new Date().toISOString(),
    lastError: message,
    result: latest.result,
  });
  process.exitCode = 1;
}
