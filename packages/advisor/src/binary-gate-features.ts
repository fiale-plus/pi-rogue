const NORMALIZE_REPLACEMENT_PATTERNS = [
  [/https?:\/\/\S+/g, " url "],
  [/[^a-z0-9\s']/g, " "],
] as const;

function normalizeBinaryGateText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(NORMALIZE_REPLACEMENT_PATTERNS[0]![0], NORMALIZE_REPLACEMENT_PATTERNS[0]![1])
    .replace(NORMALIZE_REPLACEMENT_PATTERNS[1]![0], NORMALIZE_REPLACEMENT_PATTERNS[1]![1])
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBinaryGateTokens(text: string): string[] {
  const norm = normalizeBinaryGateText(text);
  return norm ? norm.split(" ").filter(Boolean) : [];
}

function replaceSpaces(value: string): string {
  return value.replace(/\s+/g, "_");
}

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) || 0) + by);
}

export function extractBinaryGateFeatureCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const toks = normalizeBinaryGateTokens(text);
  const lower = normalizeBinaryGateText(text);

  for (const n of [1, 2]) {
    if (toks.length >= n) {
      for (let i = 0; i <= toks.length - n; i++) {
        inc(counts, `w${n}:${toks.slice(i, i + n).join("_")}`);
      }
    }
  }

  const norm = ` ${lower} `;
  for (const n of [3, 4]) {
    if (norm.length >= n) {
      for (let i = 0; i <= norm.length - n; i++) {
        const g = norm.slice(i, i + n);
        if (!/^\s+$/.test(g)) {
          inc(counts, `c${n}:${g}`);
        }
      }
    }
  }

  if (toks.length > 0) inc(counts, `pref1:${toks[0]}`);
  if (toks.length > 1) inc(counts, `pref2:${toks.slice(0, 2).join("_")}`);
  if (toks.length > 2) inc(counts, `pref3:${toks.slice(0, 3).join("_")}`);

  if (text.includes("?")) inc(counts, "cue:question_mark");

  if (toks.length > 0) {
    inc(counts, `len_bucket:${toks.length <= 3 ? "short" : toks.length <= 8 ? "medium" : "long"}`);
  }

  if (/[\?\!]/.test(text)) {
    inc(counts, "cue:question_punct");
  }

  const imperative = /^(create|add|make|change|write|fix|update|remove|delete|run|install|set|build|deploy|check|investigate|debug|review|test|refactor|merge|close|open|start|stop|continue|show|list|compact|setup|implement|build|write|create|add|make|refactor|rename|extract|migrate|patch)/i.test(text.trim());
  if (imperative) {
    inc(counts, "cue:imperative");
  }

  const safetyWords = [
    "rm -rf",
    "sudo",
    "shutdown",
    "reboot",
    "mkfs",
    "chmod -R",
    "chown",
    "git push --force",
    "curl | sh",
    "wget | sh",
    "drop table",
    "delete database",
    "secret",
    "token",
    "credential",
    "password",
    "prod",
    "production",
    "deploy",
    "deploying",
  ];
  for (const safetyWord of safetyWords) {
    if (lower.includes(safetyWord)) {
      inc(counts, `safety:${replaceSpaces(safetyWord)}`);
    }
  }

  const complexityWords = [
    "architecture",
    "refactor",
    "design",
    "tradeoff",
    "security",
    "auth",
    "migration",
    "performance",
    "scale",
    "scalability",
    "framework",
    "system design",
    "schema",
    "data model",
    "protocol",
    "advisor routing",
    "advisor flow",
    "router logic",
    "call vs skip",
    "skip vs call",
    "compare",
    "recommend",
    "benchmark",
    "evaluate",
    "experiment",
    "train",
    "strategy",
    "choose",
    "make sense",
    "worth",
    "kpi",
    "kpis",
    "how it works",
    "where it comes from",
    "what would you choose",
    "what do you think",
    "next step",
    "pick between",
    "buy",
    "usage",
    "sustained speed",
    "available models",
    "running model kpis",
  ];
  let complexityCount = 0;
  for (const complexityWord of complexityWords) {
    if (lower.includes(complexityWord)) {
      complexityCount++;
      inc(counts, `complex:${replaceSpaces(complexityWord)}`);
    }
  }
  if (complexityCount > 0) {
    inc(counts, `complex_count:${complexityCount}`);
  }

  const debugWords = ["debug", "bug", "error", "stack trace", "traceback", "fail", "broken", "investigate", "why is", "cannot", "can't", "crash", "regression"];
  for (const debugWord of debugWords) {
    if (lower.includes(debugWord)) {
      inc(counts, `debug:${replaceSpaces(debugWord)}`);
    }
  }

  const stuckWords = ["stuck", "looping", "spinning", "no progress", "no concrete progress", "same failure", "repeated failure", "repeated planning", "self talk", "forever thinking", "alternative action", "blocked"];
  for (const stuckWord of stuckWords) {
    if (lower.includes(stuckWord)) {
      inc(counts, `stuck:${replaceSpaces(stuckWord)}`);
    }
  }

  const contextWords = ["need more context", "missing context", "clarify", "not enough info", "unspecified", "unknown", "ambiguous"];
  for (const contextWord of contextWords) {
    if (lower.includes(contextWord)) {
      inc(counts, `context:${replaceSpaces(contextWord)}`);
    }
  }

  const reviewWords = ["review", "check", "verify", "validate", "diff", "pr", "pull request", "feedback"];
  for (const reviewWord of reviewWords) {
    if (lower.includes(reviewWord)) {
      inc(counts, `review:${replaceSpaces(reviewWord)}`);
    }
  }

  const doneWords = ["done", "complete", "fixed", "implemented", "works", "passing tests", "tests pass", "verified", "looks good", "merged"];
  for (const doneWord of doneWords) {
    if (lower.includes(doneWord)) {
      inc(counts, `done:${replaceSpaces(doneWord)}`);
    }
  }

  const checkinWords = ["check-in", "checkin", "mid-hour", "alignment", "progress", "status", "stats", "log", "logs"];
  for (const checkinWord of checkinWords) {
    if (lower.includes(checkinWord)) {
      inc(counts, `checkin:${replaceSpaces(checkinWord)}`);
    }
  }

  const cues = [
    "check",
    "why",
    "what",
    "how",
    "should",
    "status",
    "stats",
    "log",
    "logs",
    "review",
    "diff",
    "pr",
    "build",
    "run",
    "test",
    "deploy",
    "fix",
    "debug",
    "install",
    "configure",
    "plan",
    "continue",
    "resume",
    "compact",
    "research",
    "update",
    "patch",
    "cleanup",
    "remove",
  ];
  const multi = [
    "what is",
    "what's",
    "safe to use",
    "pull request",
    "model family",
    "how does",
    "next step",
    "path forward",
    "should we",
    "what should",
  ];

  const tokenSet = new Set(toks);
  for (const cue of cues) {
    if (tokenSet.has(cue)) {
      inc(counts, `cue:${cue}`);
    }
  }
  for (const cue of multi) {
    if (lower.includes(cue)) {
      inc(counts, `cue:${replaceSpaces(cue)}`);
    }
  }

  return counts;
}
