import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { featureFile } from "./internal.js";

export interface PersonalSpecialistCandidate {
  roleId: string;
  sourceRoleId: string;
  title: string;
  summary: string;
  confidence: number;
  matchedSignals: string[];
  sourceSessionIds: string[];
  markdownPath?: string;
}

export interface PersonalSpecialistDiscoveryInput {
  sessionRoot?: string;
  cwdContains?: string;
  allowPastSessionDiscovery?: boolean;
  outputDir?: string;
  limitSessions?: number;
  limitCandidates?: number;
}

export interface PersonalSpecialistDiscoveryResult {
  enabled: boolean;
  skipped?: string;
  scannedSessions: number;
  outputDir?: string;
  candidates: PersonalSpecialistCandidate[];
}

export interface PersonalSpecialistDiscoverySnapshot {
  version: 1;
  refreshedAt?: string;
  refreshingAt?: string;
  lastError?: string;
  result?: PersonalSpecialistDiscoveryResult;
}

export interface PersonalSpecialistDiscoveryRefreshInput extends PersonalSpecialistDiscoveryInput {
  cachePath?: string;
}

export interface PersonalSpecialistDiscoveryRefreshResult {
  queued: boolean;
  cachePath: string;
  snapshot: PersonalSpecialistDiscoverySnapshot;
}

type SessionRow = { type?: string; id?: string; cwd?: string; message?: { role?: string; content?: unknown } };

type Topic = {
  roleId: string;
  title: string;
  summary: string;
  triggerHints: string[];
  body: string;
};

const BUILTIN_ROLE_IDS = new Set<string>(["reviewer", "security", "debugger", "architecture", "reliability-perf"]);
const DEFAULT_CACHE_PATH = featureFile("advisor", "personal-specialist-discovery.json");

let activeRefreshKey: string | undefined;
let activeRefreshProcess: ReturnType<typeof spawn> | undefined;

const TOPICS: Topic[] = [
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

function walkJsonlFiles(input: string): string[] {
  if (!existsSync(input)) return [];
  const stat = statSync(input) as { isFile(): boolean; isDirectory(): boolean };
  if (stat.isFile()) return input.endsWith(".jsonl") ? [input] : [];
  const out: string[] = [];
  const stack = [input];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out.sort();
}

function readRows(file: string): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed) as SessionRow); } catch { /* skip malformed */ }
  }
  return rows;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return String(content ?? "").replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") { parts.push(item); continue; }
    const obj = item as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    else if (typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function redacted(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[abprs]|hf)[-_][A-Za-z0-9_\-]{8,}/g, "[secret]")
    .slice(0, 240);
}

function compactText(value: unknown): string {
  return redacted(textFromContent(value).toLowerCase());
}

function sessionMeta(rows: SessionRow[]): { sessionId: string; cwd: string } {
  const first = rows.find((row) => row?.type === "session") ?? {};
  return {
    sessionId: typeof first.id === "string" && first.id.trim() ? first.id : "session",
    cwd: typeof first.cwd === "string" && first.cwd.trim() ? first.cwd : "",
  };
}

function sessionMatchesCwd(cwd: string, needle: string): boolean {
  if (!needle) return true;
  if (!cwd) return false;
  const normalizedNeedle = resolve(needle).replace(/\\/g, "/");
  const normalizedCwd = resolve(cwd).replace(/\\/g, "/");
  const prefix = normalizedNeedle.endsWith("/") ? normalizedNeedle : `${normalizedNeedle}/`;
  return normalizedCwd === normalizedNeedle || normalizedCwd.startsWith(prefix);
}

function roleMarkdown(candidate: PersonalSpecialistCandidate): string {
  const topic = TOPICS.find((entry) => entry.roleId === candidate.sourceRoleId)!;
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

function generatedRoleId(sourceRoleId: string): string {
  const id = `personal-${sourceRoleId}`;
  if (BUILTIN_ROLE_IDS.has(id)) throw new Error(`generated role id collides with built-in role id: ${id}`);
  return id;
}

function defaultCachePath(): string {
  return DEFAULT_CACHE_PATH;
}

function loadSnapshot(cachePath: string): PersonalSpecialistDiscoverySnapshot {
  if (!existsSync(cachePath)) return { version: 1 };
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<PersonalSpecialistDiscoverySnapshot>;
    const result = raw.result && typeof raw.result === "object" ? raw.result : undefined;
    return {
      version: 1,
      refreshedAt: typeof raw.refreshedAt === "string" ? raw.refreshedAt : undefined,
      refreshingAt: typeof raw.refreshingAt === "string" ? raw.refreshingAt : undefined,
      lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
      result: result && Array.isArray((result as PersonalSpecialistDiscoveryResult).candidates) ? (result as PersonalSpecialistDiscoveryResult) : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

export function savePersonalSpecialistDiscoverySnapshot(cachePath: string, snapshot: PersonalSpecialistDiscoverySnapshot): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function refreshKey(input: PersonalSpecialistDiscoveryRefreshInput): string {
  return JSON.stringify({
    sessionRoot: resolve(input.sessionRoot || join(homedir(), ".pi", "agent", "sessions")),
    cwdContains: input.cwdContains || "",
    outputDir: input.outputDir || "",
    limitSessions: input.limitSessions ?? null,
    limitCandidates: input.limitCandidates ?? null,
    cachePath: resolve(input.cachePath || defaultCachePath()),
  });
}

export function loadPersonalSpecialistDiscoverySnapshot(cachePath = defaultCachePath()): PersonalSpecialistDiscoverySnapshot {
  return loadSnapshot(resolve(cachePath));
}

export function formatPersonalSpecialistDiscoverySnapshot(snapshot: PersonalSpecialistDiscoverySnapshot): string {
  const lines: string[] = [];
  lines.push(snapshot.refreshingAt ? `Discovery refresh: queued at ${snapshot.refreshingAt}` : "Discovery refresh: idle");
  if (snapshot.refreshedAt) lines.push(`Last refresh: ${snapshot.refreshedAt}`);
  if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError.slice(0, 220)}`);
  if (!snapshot.result) {
    lines.push("No cached candidates yet.");
    return lines.join("\n");
  }
  lines.push(`Cached candidates: ${snapshot.result.candidates.length}`);
  if (snapshot.result.outputDir) lines.push(`Output: ${snapshot.result.outputDir}`);
  for (const candidate of snapshot.result.candidates) {
    lines.push(`- ${candidate.roleId} (${candidate.confidence.toFixed(2)}): ${candidate.matchedSignals.join(", ") || "signals: none"}`);
  }
  return lines.join("\n");
}

export function queuePersonalSpecialistDiscoveryRefresh(input: PersonalSpecialistDiscoveryRefreshInput): PersonalSpecialistDiscoveryRefreshResult {
  const cachePath = resolve(input.cachePath || defaultCachePath());
  const key = refreshKey(input);
  const snapshot = loadSnapshot(cachePath);
  if (activeRefreshProcess && activeRefreshKey === key) {
    return { queued: false, cachePath, snapshot };
  }

  const queuedAt = new Date().toISOString();
  const queuedSnapshot: PersonalSpecialistDiscoverySnapshot = { version: 1, refreshedAt: snapshot.refreshedAt, refreshingAt: queuedAt, lastError: undefined, result: snapshot.result };
  savePersonalSpecialistDiscoverySnapshot(cachePath, queuedSnapshot);
  activeRefreshKey = key;
  const workerScript = fileURLToPath(new URL("./personal-specialist-discovery-worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerScript], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PI_ROGUE_PERSONAL_SPECIALIST_REFRESH: JSON.stringify({ ...input, cachePath }),
    },
  });
  activeRefreshProcess = child;
  child.unref();
  child.on("exit", () => {
    if (activeRefreshProcess === child) {
      activeRefreshProcess = undefined;
      activeRefreshKey = undefined;
    }
  });
  child.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const latest = loadSnapshot(cachePath);
    savePersonalSpecialistDiscoverySnapshot(cachePath, { version: 1, refreshedAt: new Date().toISOString(), lastError: message, result: latest.result });
    if (activeRefreshProcess === child) {
      activeRefreshProcess = undefined;
      activeRefreshKey = undefined;
    }
  });
  return { queued: true, cachePath, snapshot: queuedSnapshot };
}

export function discoverPersonalSpecialists(input: PersonalSpecialistDiscoveryInput): PersonalSpecialistDiscoveryResult {
  if (!input.allowPastSessionDiscovery) {
    return { enabled: false, skipped: "consent_required", scannedSessions: 0, candidates: [] };
  }

  const sessionRoot = resolve(input.sessionRoot || join(homedir(), ".pi", "agent", "sessions"));
  const cwdContains = input.cwdContains || "";
  const files = walkJsonlFiles(sessionRoot);
  const byRole = new Map<string, { topic: Topic; sourceSessionIds: Set<string>; matchedSignals: Set<string>; hits: number }>();
  let scannedSessions = 0;
  let matchedSessions = 0;

  for (const file of files) {
    const rows = readRows(file);
    const meta = sessionMeta(rows);
    if (!sessionMatchesCwd(meta.cwd, cwdContains)) continue;
    matchedSessions += 1;
    if (input.limitSessions !== undefined && matchedSessions > input.limitSessions) break;
    scannedSessions += 1;
    const texts: string[] = [];
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
      const record = byRole.get(topic.roleId) ?? { topic, sourceSessionIds: new Set<string>(), matchedSignals: new Set<string>(), hits: 0 };
      record.sourceSessionIds.add(meta.sessionId);
      hits.forEach((hit) => record.matchedSignals.add(hit));
      record.hits += hits.length;
      byRole.set(topic.roleId, record);
    }
  }

  const candidates: PersonalSpecialistCandidate[] = [...byRole.values()]
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
