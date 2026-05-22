import { createHash } from "node:crypto";

export const LABELS = ["planning", "implementation", "debugging", "review", "research", "ops", "handoff"] as const;
export type Label = (typeof LABELS)[number];
export type ConfidenceSource = "explicit" | "heuristic";

export interface RoutingPrediction {
  label?: Label;
  confidence: number;
  reason: string;
  source: ConfidenceSource;
}

const QUICK_EDIT_RE = /\b(quick edit|small edit|tiny edit|rename|format(?:ting)?|lint|style|doc(?:s)?|comment|typo|readme|spell|spacing|cleanup|one[- ]?liner)\b/i;
const COMPLEX_RE = /\b(architecture|architectural|refactor|design|trade[- ]?off|concurrency|security|auth|migration|performance|scale|scalability|framework|system design|review|schema|data model|protocol)\b/i;
const DEBUG_RE = /\b(debug|bug|error|stack trace|traceback|fail(?:ed|ure)?|broken|investigate|why is|cannot|can't|crash)\b/i;
const CONTEXT_RE = /\b(need more context|missing context|clarify|not enough info|unspecified|unknown|ambiguous)\b/i;
const OPS_RE = /\b(install|configure|settings?|theme|cmux|ghostty|setup|enable|disable|update|deploy|shell|terminal|environment|path)\b/i;
const RESEARCH_RE = /\b(research|docs?|documentation|compare|benchmark|look up|find out|what is|how does)\b/i;
const HANDOFF_RE = /\b(\/compact|compact|resume|continue|handoff|pick up|move on|wrap up|carry on)\b/i;
const PLANNING_RE = /\b(plan|scope|architecture|design|strategy|next step|what should|should we|roadmap)\b/i;
const IMPLEMENTATION_RE = /\b(implement|build|create|write|add|edit|refactor|change|make|code|script)\b/i;

function normalizeText(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function hasAny(text: string, list: Array<RegExp>): boolean {
  return list.some((re) => re.test(text));
}

function classReason(label: Label): string {
  switch (label) {
    case "handoff": return "handoff/compact signal";
    case "review": return "review signal";
    case "debugging": return "debugging signal";
    case "research": return "research/question signal";
    case "ops": return "ops/config signal";
    case "implementation": return "implementation signal";
    case "planning": return "planning signal";
  }
}

export function classifyRoutingText(text: unknown, cwd?: string): RoutingPrediction {
  const raw = normalizeText(text);
  const lower = raw.toLowerCase();
  const cwdLower = (cwd || "").toLowerCase();

  if (!raw) {
    return { confidence: 0.1, reason: "empty", source: "heuristic" };
  }

  if (HANDOFF_RE.test(lower)) {
    return { label: "handoff", confidence: 0.96, reason: classReason("handoff"), source: "explicit" };
  }
  if (RESEARCH_RE.test(lower)) {
    return { label: "research", confidence: 0.85, reason: classReason("research"), source: "heuristic" };
  }
  if (DEBUG_RE.test(lower)) {
    return { label: "debugging", confidence: 0.9, reason: classReason("debugging"), source: "heuristic" };
  }
  if (OPS_RE.test(lower) || /cmux|ghostty/.test(cwdLower)) {
    return { label: "ops", confidence: 0.84, reason: classReason("ops"), source: "heuristic" };
  }
  if (PLANNING_RE.test(lower)) {
    return { label: "planning", confidence: 0.8, reason: classReason("planning"), source: "heuristic" };
  }
  if (IMPLEMENTATION_RE.test(lower)) {
    return { label: "implementation", confidence: 0.81, reason: classReason("implementation"), source: "heuristic" };
  }
  if (hasAny(lower, [QUICK_EDIT_RE])) {
    return { label: "implementation", confidence: 0.72, reason: "light edit signal", source: "heuristic" };
  }
  if (CONTEXT_RE.test(lower) || raw.length < 18 || raw.split(/\s+/).length < 4) {
    return { confidence: 0.22, reason: "ambiguous", source: "heuristic" };
  }

  return { confidence: 0.2, reason: "ambiguous", source: "heuristic" };
}

export function labelCounts(rows: Array<{ label: string }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.label] = (acc[row.label] || 0) + 1;
    return acc;
  }, {});
}

export function majorityLabel(rows: Array<{ label: string }>): string | undefined {
  const counts = labelCounts(rows);
  let best: { label?: string; count: number } = { count: -1 };
  for (const [label, count] of Object.entries(counts)) {
    if (count > best.count) best = { label, count };
  }
  return best.label;
}

export function hashText(...parts: string[]): string {
  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}
