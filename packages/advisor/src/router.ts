import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendText, featureFile, truncate } from "@fiale-plus/pi-core";

export type AdvisorPhase = "preflight" | "review" | "closeout";
export type PreflightLabel = "continue" | "escalate_to_advisor" | "need_more_context" | "low_confidence";
export type ReviewLabel = "on_track" | "course_correct" | "not_done" | "abstain";
export type RouterSource = "heuristic" | "llm";
export type PreflightPolicy = "off" | "light" | "full" | "direct";
export type ReviewPolicy = "off" | "light" | "strict";

export interface AdvisorRouteInput {
  phase: AdvisorPhase;
  text: string;
  brief?: string;
  fileChanged?: boolean;
  failed?: boolean;
}

export interface AdvisorRouteDecision {
  phase: AdvisorPhase;
  label: PreflightLabel | ReviewLabel;
  confidence: number;
  reason: string;
  source: RouterSource;
  preflight: PreflightPolicy;
  review: ReviewPolicy;
  escalate: boolean;
  safety: boolean;
  promptHash: string;
  promptSummary: string;
  briefSummary?: string;
}

export interface RouterResponse {
  label: PreflightLabel | ReviewLabel;
  confidence?: number;
  reason?: string;
}

const ROUTER_LOG_PATH = featureFile("advisor", "evals/advisor-router.jsonl");
const ROUTER_VERSION = 1;

// ── Binary gate model (trained from local session data) ──────────────────
const BINARY_GATE_PATH = featureFile("advisor", "binary-gate-model.json");
const BINARY_GATE_THRESHOLD = 0.55;

interface BinaryGateModel {
  kind: string;
  labels: string[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
}

let _binaryGateCache: BinaryGateModel | null | undefined = undefined;

function loadBinaryGate(): BinaryGateModel | null {
  if (_binaryGateCache !== undefined) return _binaryGateCache;
  try {
    if (!existsSync(BINARY_GATE_PATH)) return null;
    _binaryGateCache = JSON.parse(readFileSync(BINARY_GATE_PATH, "utf8")) as BinaryGateModel;
    if (_binaryGateCache.kind !== "binary-logreg-v1") { _binaryGateCache = null; return null; }
    return _binaryGateCache;
  } catch { _binaryGateCache = null; return null; }
}

function binaryGateTokens(text: string): string[] {
  const norm = String(text ?? "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ").trim();
  return norm ? norm.split(" ").filter(Boolean) : [];
}

function binaryGateFeatures(text: string, model: BinaryGateModel) {
  const toks = binaryGateTokens(text);
  const lower = String(text ?? "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ").trim();
  const counts = new Map<string, number>();
  const inc = (k: string, b = 1) => counts.set(k, (counts.get(k) || 0) + b);
  for (const n of [1, 2]) {
    if (toks.length >= n) for (let i = 0; i <= toks.length - n; i++)
      inc(`w${n}:${toks.slice(i, i + n).join("_")}`);
  }
  const norm = ` ${lower} `;
  for (const n of [3, 4]) {
    if (norm.length >= n) for (let i = 0; i <= norm.length - n; i++) {
      const g = norm.slice(i, i + n);
      if (!/^\s+$/.test(g)) inc(`c${n}:${g}`);
    }
  }
  if (toks.length > 0) inc(`pref1:${toks[0]}`);
  if (toks.length > 1) inc(`pref2:${toks.slice(0, 2).join("_")}`);
  if (toks.length > 2) inc(`pref3:${toks.slice(0, 3).join("_")}`);
  if (text.includes("?")) inc("cue:question_mark");
  const cues = ["check","why","what","how","should","status","stats","log","logs","review","diff","pr","build","run","test","deploy","fix","debug","install","configure","plan","continue","resume","compact","research","update","patch","cleanup","remove"];
  const multi = ["what is","what's","safe to use","pull request","model family","how does","next step","path forward","should we","what should"];
  const ts = new Set(toks);
  for (const c of cues) if (ts.has(c)) inc(`cue:${c}`);
  for (const c of multi) if (lower.includes(c)) inc(`cue:${c.replace(/\s+/g,"_")}`);

  const index = new Map(model.features.map((f, i) => [f, i]));
  const pairs: Array<[number, number]> = [];
  let nrm = 0;
  for (const [feature, tf] of counts) {
    const idx = index.get(feature);
    if (idx === undefined) continue;
    const value = (1 + Math.log(tf)) * model.idf[idx];
    pairs.push([idx, value]); nrm += value * value;
  }
  const scale = nrm > 0 ? 1 / Math.sqrt(nrm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return { I: pairs.map(([i]) => i), V: pairs.map(([, v]) => v * scale) };
}

function binaryGatePredict(text: string): { decision: "continue" | "escalate"; confidence: number } | null {
  const model = loadBinaryGate();
  if (!model) return null;
  const vec = binaryGateFeatures(text, model);
  const scores = model.bias.slice();
  for (let c = 0; c < model.weights.length; c++) {
    let score = scores[c]; const w = model.weights[c];
    for (let i = 0; i < vec.I.length; i++) score += w[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }
  const maxS = Math.max(...scores);
  const exps = scores.map((v) => Math.exp(v - maxS));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const probs = exps.map((v) => v / sum);
  const idx = probs[0] >= probs[1] ? 0 : 1;
  return { decision: model.labels[idx] as "continue" | "escalate", confidence: probs[idx] };
}

const QUICK_EDIT_RE = /\b(quick edit|small edit|tiny edit|rename|format(?:ting)?|lint|style|doc(?:s)?|comment|typo|readme|spell|spacing|cleanup|one[- ]?liner)\b/i;
const COMPLEX_RE = /\b(architecture|architectural|refactor|design|trade[- ]?off|concurrency|security|auth|migration|performance|scale|scalability|framework|system design|review|schema|data model|protocol)\b/i;
const DEBUG_RE = /\b(debug|bug|error|stack trace|traceback|fail(?:ed|ure)?|broken|investigate|why is|cannot|can't|crash)\b/i;
const CONTEXT_RE = /\b(need more context|missing context|clarify|not enough info|unspecified|unknown|ambiguous)\b/i;
const SAFETY_RE = /\b(rm\s+-rf|sudo\b|shutdown\b|reboot\b|mkfs(?:\.[\w-]+)?\b|chmod\s+-R\b|chown\b|git\s+push\b[\s\S]*--force(?:-with-lease)?|curl\b[\s\S]*\|\s*(?:sh|bash)\b|wget\b[\s\S]*\|\s*(?:sh|bash)\b|drop\s+table\b|delete\s+database\b|secret\b|token\b|credential\b|password\b)\b/i;
const DONE_RE = /\b(done|complete(?:d)?|fixed|implemented|works?|passing tests?|tests pass|verified|looks good|merged)\b/i;
const NEEDS_WORK_RE = /\b(todo|wip|incomplete|missing|broken|fails?|error|bug|revise|adjust|fix(?:ed)?\s+needed|not done|still open)\b/i;

function squish(text: unknown, max = 220): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function hashText(...parts: string[]): string {
  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}

function clampConfidence(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizePhaseLabel(phase: AdvisorPhase, label: unknown): PreflightLabel | ReviewLabel | null {
  const value = String(label ?? "").trim();
  if (phase === "preflight") {
    return value === "continue" || value === "escalate_to_advisor" || value === "need_more_context" || value === "low_confidence"
      ? value
      : null;
  }
  return value === "on_track" || value === "course_correct" || value === "not_done" || value === "abstain"
    ? value
    : null;
}

function preflightPolicy(label: PreflightLabel): PreflightPolicy {
  switch (label) {
    case "continue": return "off";
    case "escalate_to_advisor": return "full";
    case "need_more_context": return "direct";
    case "low_confidence": return "light";
  }
}

function reviewPolicy(label: ReviewLabel): ReviewPolicy {
  switch (label) {
    case "on_track": return "off";
    case "course_correct": return "light";
    case "not_done": return "strict";
    case "abstain": return "off";
  }
}

function isSafetySensitive(text: string): boolean {
  return SAFETY_RE.test(text);
}

function hasQuickEditSignal(text: string): boolean {
  return QUICK_EDIT_RE.test(text);
}

function hasComplexSignal(text: string): boolean {
  return COMPLEX_RE.test(text) || DEBUG_RE.test(text);
}

function needsContext(text: string): boolean {
  return CONTEXT_RE.test(text) || text.trim().length < 18 || text.trim().split(/\s+/).length < 4;
}

function reviewSignals(input: AdvisorRouteInput): { label: ReviewLabel; confidence: number; reason: string } {
  const text = `${input.text}\n${input.brief ?? ""}`.trim();
  if (input.failed) {
    return { label: "not_done", confidence: 0.95, reason: "Turn reported failure." };
  }
  if (NEEDS_WORK_RE.test(text)) {
    return { label: /\b(not done|incomplete|wip|todo|still open)\b/i.test(text) ? "not_done" : "course_correct", confidence: 0.83, reason: "Needs-work signal detected." };
  }
  if (input.fileChanged && DONE_RE.test(text)) {
    return { label: "on_track", confidence: 0.84, reason: "Change looks complete." };
  }
  if (DONE_RE.test(text)) {
    return { label: "on_track", confidence: 0.72, reason: "Completion signal detected." };
  }
  return { label: "abstain", confidence: 0.56, reason: "Insufficient review signal." };
}

function preflightSignals(input: AdvisorRouteInput): { label: PreflightLabel; confidence: number; reason: string; safety: boolean } {
  const text = `${input.text}\n${input.brief ?? ""}`.trim();
  if (isSafetySensitive(text)) {
    return { label: "escalate_to_advisor", confidence: 0.98, reason: "Safety-sensitive keywords detected.", safety: true };
  }
  if (hasQuickEditSignal(text) && !hasComplexSignal(text)) {
    return { label: "continue", confidence: 0.9, reason: "Small-edit signal detected.", safety: false };
  }
  if (hasComplexSignal(text)) {
    return { label: "escalate_to_advisor", confidence: 0.88, reason: "Complex or high-uncertainty work detected.", safety: false };
  }
  if (needsContext(text)) {
    return { label: "need_more_context", confidence: 0.66, reason: "Prompt is too underspecified.", safety: false };
  }
  return { label: "low_confidence", confidence: 0.54, reason: "No strong routing signal.", safety: false };
}

export function heuristicRoute(input: AdvisorRouteInput): AdvisorRouteDecision {
  if (input.phase === "review" || input.phase === "closeout") {
    const result = reviewSignals(input);
    return {
      phase: input.phase,
      label: result.label,
      confidence: result.confidence,
      reason: result.reason,
      source: "heuristic",
      preflight: "off",
      review: reviewPolicy(result.label),
      escalate: result.label !== "on_track" && result.label !== "abstain",
      safety: false,
      promptHash: hashText(input.phase, input.text, input.brief ?? "", String(input.fileChanged ?? false), String(input.failed ?? false)),
      promptSummary: squish(input.text, 220),
      briefSummary: input.brief ? squish(input.brief, 220) : undefined,
    };
  }

  const result = preflightSignals(input);
  return {
    phase: input.phase,
    label: result.label,
    confidence: result.confidence,
    reason: result.reason,
    source: "heuristic",
    preflight: preflightPolicy(result.label),
    review: result.label === "continue" ? "off" : result.label === "escalate_to_advisor" ? "light" : "light",
    escalate: result.label === "escalate_to_advisor",
    safety: result.safety,
    promptHash: hashText(input.phase, input.text, input.brief ?? "", String(input.fileChanged ?? false), String(input.failed ?? false)),
    promptSummary: squish(input.text, 220),
    briefSummary: input.brief ? squish(input.brief, 220) : undefined,
  };
}

export function shouldQueryClassifier(route: AdvisorRouteDecision): boolean {
  if (route.safety) return false;
  if (route.phase === "preflight") {
    return route.label === "low_confidence" || route.label === "need_more_context" || route.confidence < 0.7;
  }
  return route.label === "abstain" || route.confidence < 0.68;
}

export function buildRouterPrompt(input: AdvisorRouteInput): string {
  const phase = input.phase;
  const labels = phase === "preflight"
    ? "continue | escalate_to_advisor | need_more_context | low_confidence"
    : "on_track | course_correct | not_done | abstain";

  return [
    "You are a routing classifier for a coding assistant. Return ONLY valid JSON.",
    `Phase: ${phase}`,
    `Allowed labels: ${labels}`,
    "Format: {\"label\":\"...\",\"confidence\":0-1,\"reason\":\"...\"}",
    `Task: ${squish(input.text, 800)}`,
    input.brief ? `Recent context: ${squish(input.brief, 500)}` : "",
    input.fileChanged !== undefined ? `File changed: ${String(input.fileChanged)}` : "",
    input.failed !== undefined ? `Failed: ${String(input.failed)}` : "",
    phase === "preflight"
      ? [
        "Guidance: continue for tiny edits and direct answers; escalate_to_advisor for architecture, design, tradeoffs, security, or high uncertainty; need_more_context when underspecified; low_confidence when mixed signals.",
      ].join(" ")
      : [
        "Guidance: on_track for clearly complete work; course_correct for partial work that needs changes; not_done when incomplete or failing; abstain when there is not enough signal.",
      ].join(" "),
  ].filter(Boolean).join("\n");
}

export function parseRouterResponse(phase: AdvisorPhase, text: string): RouterResponse | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned) as { label?: unknown; confidence?: unknown; reason?: unknown; decision?: unknown };
    const label = normalizePhaseLabel(phase, parsed.label ?? parsed.decision);
    if (!label) return null;
    return {
      label,
      confidence: clampConfidence(parsed.confidence, 0.5),
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "Classifier returned no reason.",
    };
  } catch {
    return null;
  }
}

export function mergeClassifierDecision(input: AdvisorRouteInput, decision: RouterResponse, source: RouterSource): AdvisorRouteDecision {
  if (input.phase === "review" || input.phase === "closeout") {
    const label = normalizePhaseLabel(input.phase, decision.label) as ReviewLabel | null;
    const finalLabel: ReviewLabel = label ?? reviewSignals(input).label;
    const confidence = clampConfidence(decision.confidence, 0.5);
    return {
      phase: input.phase,
      label: finalLabel,
      confidence,
      reason: decision.reason?.trim() || "Classifier returned no reason.",
      source,
      preflight: "off",
      review: reviewPolicy(finalLabel),
      escalate: finalLabel !== "on_track" && finalLabel !== "abstain",
      safety: false,
      promptHash: hashText(input.phase, input.text, input.brief ?? "", String(input.fileChanged ?? false), String(input.failed ?? false)),
      promptSummary: squish(input.text, 220),
      briefSummary: input.brief ? squish(input.brief, 220) : undefined,
    };
  }

  const label = normalizePhaseLabel(input.phase, decision.label) as PreflightLabel | null;
  const finalLabel: PreflightLabel = label ?? preflightSignals(input).label;
  const confidence = clampConfidence(decision.confidence, 0.5);
  return {
    phase: input.phase,
    label: finalLabel,
    confidence,
    reason: decision.reason?.trim() || "Classifier returned no reason.",
    source,
    preflight: preflightPolicy(finalLabel),
    review: finalLabel === "continue" ? "off" : finalLabel === "escalate_to_advisor" ? "light" : "light",
    escalate: finalLabel === "escalate_to_advisor",
    safety: isSafetySensitive(`${input.text}\n${input.brief ?? ""}`),
    promptHash: hashText(input.phase, input.text, input.brief ?? "", String(input.fileChanged ?? false), String(input.failed ?? false)),
    promptSummary: squish(input.text, 220),
    briefSummary: input.brief ? squish(input.brief, 220) : undefined,
  };
}

export function routeLogEntry(route: AdvisorRouteDecision): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    version: ROUTER_VERSION,
    phase: route.phase,
    label: route.label,
    confidence: route.confidence,
    reason: truncate(route.reason, 240),
    source: route.source,
    safety: route.safety,
    escalate: route.escalate,
    preflight: route.preflight,
    review: route.review,
    promptHash: route.promptHash,
    prompt: route.promptSummary,
    brief: route.briefSummary,
  };
}

export function appendRouteLog(route: AdvisorRouteDecision): void {
  appendText(ROUTER_LOG_PATH, `${JSON.stringify(routeLogEntry(route))}\n`);
}

export function routeNote(route: AdvisorRouteDecision): string {
  if (route.phase === "preflight") {
    switch (route.label as PreflightLabel) {
      case "continue": return "";
      case "escalate_to_advisor": return "Advisor router: complex/high-risk work detected — call /advisor if you need SOTA guidance.";
      case "need_more_context": return "Advisor router: ask for the missing details before proceeding.";
      case "low_confidence": return "Advisor router: low confidence — proceed cautiously and consult /advisor if needed.";
    }
  }

  switch (route.label as ReviewLabel) {
    case "on_track": return "";
    case "course_correct": return "Advisor review: course correction needed before closing this out.";
    case "not_done": return "Advisor review: work appears incomplete — do not mark as done yet.";
    case "abstain": return "";
  }
}

export function mergeReviewPolicy(base: ReviewPolicy, route: ReviewPolicy): ReviewPolicy {
  if (base === "off") return "off";
  if (route === "strict") return "strict";
  if (route === "light") return base === "strict" ? "strict" : "light";
  return base;
}

export function summarizeRoute(route: AdvisorRouteDecision): string {
  const phase = route.phase === "closeout" ? "closeout" : route.phase;
  return `${phase}:${route.label} (${Math.round(route.confidence * 100)}%)`;
}
