import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendText, featureFile, truncate } from "./internal.js";
import { extractBinaryGateFeatureCounts } from "./binary-gate-features.js";
import { applyCalibration, TRAJECTORY_FEATURE_NAMES, trajectoryFeatureVector, type Calibration, type TrajectoryFeatures } from "./binary-gate-eval.js";

export type AdvisorPhase = "preflight" | "review" | "closeout";
export type PreflightLabel = "continue" | "escalate_to_advisor" | "need_more_context" | "low_confidence";
export type ReviewLabel = "on_track" | "course_correct" | "not_done" | "abstain";
export type RouterSource = "heuristic" | "model" | "llm";
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
  trajectory?: TrajectoryFeatures;
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
const BINARY_GATE_SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/binary-gate-model.json");
// v1 assets have no `thresholds`/`calibration`; this legacy trust gate preserves
// their pre-v2 behavior (do not act on low-confidence predictions). v2 assets are
// calibrated and governed by artifact thresholds, so they are always trusted when
// present. Superseded once a v2 model is promoted into assets/.
const LEGACY_V1_TRUST_THRESHOLD = 0.55;

type GateThresholds = {
  default: number;
  preflight?: number;
  review?: number;
  closeout?: number;
};

export interface BinaryGateModel {
  kind: "binary-logreg-v1" | "binary-logreg-v2";
  labels: string[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
  config?: Record<string, unknown>;
  calibration?: Calibration;
  thresholds?: GateThresholds;
  /** Optional v4 stacked second-stage model over [textGateProb, ...trajectoryFeatures]. */
  stacked?: StackedGateModel;
}

/**
 * v4 stacked second-stage logistic regression. Input vector is
 * [textGateProbEscalate, ...normalized trajectory features] (ordered by
 * TRAJECTORY_FEATURE_NAMES). Output is the final P(escalate) used for the
 * decision. Only active when the artifact has `stacked` AND the caller passes
 * trajectory features; otherwise the text-only calibrated probability is used.
 */
export interface StackedGateModel {
  /** Ordered trajectory feature names this model was trained on. */
  trajectoryFeatures: string[];
  /** Bias for the escalate logit. */
  bias: number;
  /** Weights for [textGateProb, ...trajectoryFeatures]. */
  weights: number[];
  /** Optional second-stage calibration. */
  calibration?: Calibration;
  /** Optional stacked-specific thresholds; otherwise fall back to text thresholds. */
  thresholds?: GateThresholds;
}

export interface BinaryGateArtifactStatus {
  path: string;
  available: boolean;
  usable: boolean;
  source: "installed" | "bundled" | "seeded" | "missing" | "malformed" | "unsupported";
  kind?: BinaryGateModel["kind"];
  features?: number;
  labels?: string[];
  stacked?: boolean;
  thresholds?: GateThresholds;
  error?: string;
}

let _binaryGateCache: BinaryGateModel | null | undefined = undefined;

function ensureBinaryGateSeeded(): void {
  try {
    if (!existsSync(BINARY_GATE_SOURCE_PATH)) return;
    const sourceStat = statSync(BINARY_GATE_SOURCE_PATH);
    if (existsSync(BINARY_GATE_PATH)) {
      const installedStat = statSync(BINARY_GATE_PATH);
      if (installedStat.mtimeMs >= sourceStat.mtimeMs && installedStat.size === sourceStat.size) return;
    }
    mkdirSync(dirname(BINARY_GATE_PATH), { recursive: true });
    copyFileSync(BINARY_GATE_SOURCE_PATH, BINARY_GATE_PATH);
  } catch {
    // best effort: if the seed copy fails, fall back to the installed path if present
  }
}

function isSupportedBinaryGateModel(value: unknown): value is BinaryGateModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<BinaryGateModel>;
  if (model.config?.weakLabelResearch === true) return false;
  return (model.kind === "binary-logreg-v1" || model.kind === "binary-logreg-v2") &&
    Array.isArray(model.labels) &&
    Array.isArray(model.features) &&
    Array.isArray(model.idf) &&
    Array.isArray(model.bias) &&
    Array.isArray(model.weights);
}

export function binaryGateArtifactPath(): string {
  return BINARY_GATE_PATH;
}

function inspectBinaryGateJson(path: string, source: BinaryGateArtifactStatus["source"]): BinaryGateArtifactStatus {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isSupportedBinaryGateModel(parsed)) {
      const kind = parsed && typeof parsed === "object" ? String((parsed as { kind?: unknown }).kind ?? "unknown") : typeof parsed;
      return { path, available: true, usable: false, source: "unsupported", error: `unsupported artifact kind/shape: ${kind}` };
    }
    return {
      path,
      available: true,
      usable: true,
      source,
      kind: parsed.kind,
      labels: parsed.labels.slice(0, 4),
      features: parsed.features.length,
      stacked: Boolean(parsed.stacked),
      thresholds: parsed.thresholds,
    };
  } catch (error) {
    return {
      path,
      available: true,
      usable: false,
      source: "malformed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function inspectBinaryGateArtifact(path: string = BINARY_GATE_PATH, seed = false): BinaryGateArtifactStatus {
  const existedBeforeSeed = existsSync(path);
  if (seed) ensureBinaryGateSeeded();
  if (existsSync(path)) return inspectBinaryGateJson(path, seed && !existedBeforeSeed ? "seeded" : "installed");
  // Read-only status should not materialize runtime files, but it should still
  // report the bundled gate accurately because loadBinaryGate() can seed it
  // before prediction. Inspect the package asset directly as a non-mutating
  // fallback for the canonical runtime path.
  if (!seed && path === BINARY_GATE_PATH && existsSync(BINARY_GATE_SOURCE_PATH)) {
    return inspectBinaryGateJson(BINARY_GATE_SOURCE_PATH, "bundled");
  }
  return { path, available: false, usable: false, source: "missing", error: "artifact missing" };
}

function loadBinaryGate(): BinaryGateModel | null {
  if (_binaryGateCache !== undefined) return _binaryGateCache;
  try {
    ensureBinaryGateSeeded();
    if (!existsSync(BINARY_GATE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(BINARY_GATE_PATH, "utf8")) as unknown;
    if (!isSupportedBinaryGateModel(parsed)) { _binaryGateCache = null; return null; }
    _binaryGateCache = parsed;
    return _binaryGateCache;
  } catch { _binaryGateCache = null; return null; }
}

function binaryGateFeatures(text: string, model: BinaryGateModel) {
  const counts = extractBinaryGateFeatureCounts(text);
  const index = new Map(model.features.map((f, i) => [f, i]));
  const pairs: Array<[number, number]> = [];
  let nrm = 0;
  for (const [feature, tf] of counts) {
    const idx = index.get(feature);
    if (idx === undefined) continue;
    const value = (1 + Math.log(tf)) * model.idf[idx];
    pairs.push([idx, value]);
    nrm += value * value;
  }
  const scale = nrm > 0 ? 1 / Math.sqrt(nrm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return { I: pairs.map(([i]) => i), V: pairs.map(([, v]) => v * scale) };
}

export interface BinaryGatePrediction {
  decision: "continue" | "escalate";
  /** Probability mass on the chosen class. Back-compat with the old return shape. */
  confidence: number;
  /** Calibrated P(escalate). */
  probability: number;
  /** Operating threshold used for this decision. */
  threshold: number;
  /** Whether the caller should act on this prediction. v2 = true; v1 = legacy confidence gate. */
  trusted: boolean;
  source: "model-v2" | "model-v1-legacy";
}

function thresholdFor(model: BinaryGateModel, phase?: AdvisorPhase): number {
  const t = model.thresholds;
  if (t) return t[phase ?? "default"] ?? t.default ?? 0.5;
  // v1 assets: argmax-equivalent decision boundary.
  return 0.5;
}

export function predictWithModel(model: BinaryGateModel, text: string, phase?: AdvisorPhase, trajectory?: TrajectoryFeatures): BinaryGatePrediction {
  const vec = binaryGateFeatures(text, model);
  const scores = model.bias.slice();
  for (let c = 0; c < model.weights.length; c++) {
    let score = scores[c]; const w = model.weights[c];
    for (let i = 0; i < vec.I.length; i++) score += w[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }
  // labels are ["continue","escalate"]; escalate is index 1.
  const escalateLogit = scores[1] - scores[0];
  let probEscalate = applyCalibration(escalateLogit, model.calibration);
  const stacked = model.stacked;
  const stackedUsable = Boolean(
    stacked && trajectory &&
    stacked.weights.length === 1 + TRAJECTORY_FEATURE_NAMES.length &&
    stacked.trajectoryFeatures.length === TRAJECTORY_FEATURE_NAMES.length &&
    stacked.trajectoryFeatures.every((feature, index) => feature === TRAJECTORY_FEATURE_NAMES[index]),
  );
  if (stackedUsable && stacked) {
    const trajVec = trajectoryFeatureVector(trajectory);
    const input = [probEscalate, ...trajVec];
    const stackedLogit = stacked.bias + stacked.weights.reduce((acc, wj, j) => acc + wj * (input[j] ?? 0), 0);
    probEscalate = applyCalibration(stackedLogit, stacked.calibration);
  }
  const threshold = stackedUsable && stacked?.thresholds ? (stacked.thresholds[phase ?? "default"] ?? stacked.thresholds.default ?? thresholdFor(model, phase)) : thresholdFor(model, phase);
  const decision: "continue" | "escalate" = probEscalate >= threshold ? "escalate" : "continue";
  const confidence = Math.max(probEscalate, 1 - probEscalate);
  const isV2 = model.kind === "binary-logreg-v2";
  const trusted = isV2 || confidence >= LEGACY_V1_TRUST_THRESHOLD;
  return { decision, confidence, probability: probEscalate, threshold, trusted, source: isV2 ? "model-v2" : "model-v1-legacy" };
}

export function binaryGatePredict(text: string, phase?: AdvisorPhase, trajectory?: TrajectoryFeatures): BinaryGatePrediction | null {
  const model = loadBinaryGate();
  if (!model) return null;
  return predictWithModel(model, text, phase, trajectory);
}

const QUICK_EDIT_RE = /\b(quick edit|small edit|tiny edit|rename|format(?:ting)?|lint|style|doc(?:s)?|comment|typo|readme|spell|spacing|cleanup|one[- ]?liner)\b/i;
const ROUTINE_CLEANUP_RE = /\b(routine docs?|docs? and formatting|formatting cleanup|generated changes|large diff|docs?\/formatting)\b/i;
const COMPLEX_RE = /\b(architecture|architectural|refactor|design|trade[- ]?off|concurrency|security|auth|migration|performance|scale|scalability|framework|system design|schema|data model|protocol|advisor routing|advisor flow|router logic|call vs skip|skip vs call|compare|recommend|benchmark|evaluate|experiment|train|strategy|choose|make sense|worth(?: it)?|kpi|kpis|how it works|where it comes from|what would you choose|what do you think|next step|pick between|buy|usage|sustained speed|available models|running model kpis)\b/i;
const DEBUG_RE = /\b(debug|bug|error|stack trace|traceback|fail(?:ed|ure)?|broken|investigate|why is|cannot|can't|crash|regression)\b/i;
const STUCK_RE = /\b(stuck|looping|spinning|no[- ]?progress|no concrete progress|same failure|repeated failure|repeated planning|self[- ]?talk|forever thinking|strategy change|alternative action|blocked)\b/i;
const CONTEXT_RE = /\b(need more context|missing context|clarify|not enough info|unspecified|unknown|ambiguous)\b/i;
const SAFETY_RE = /\b(rm\s+-rf|sudo\b|shutdown\b|reboot\b|mkfs(?:\.[\w-]+)?\b|chmod\s+-R\b|chown\b|git\s+push\b[\s\S]*--force(?:-with-lease)?|curl\b[\s\S]*\|\s*(?:sh|bash)\b|wget\b[\s\S]*\|\s*(?:sh|bash)\b|drop\s+table\b|delete\s+database\b|credential\b|password\b|secret\b)\b/i;
const COMPACTION_RE = /\b(compact(?:ed|ion)?|missing history|history might flip|prior constraint|resume(?:d)? after compaction)\b/i;
const REASSURANCE_RE = /\b(reassurance|confidence|increase confidence|already know the likely answer|just for reassurance|main model already gives a solid answer|solid answer)\b/i;
const CHECKPOINT_RE = /\b(checkpoint|multi-step implementation|clearer boundary|interrupt now|wait until there is a clearer boundary|mid implementation)\b/i;
const CHEAP_SIGNAL_RE = /\b(cheap extra signal|exact diff plus exact error|exact diff|exact error|recent error in the session history|recent history)\b/i;
const CLOSEOUT_RE = /\b(closeout|on[- ]?track|course[- ]?correct|not[- ]?done|should this be marked|mostly done|mostly complete|needs changes before closeout|needs changes|needs correction|review judgment)\b/i;
const REVIEW_NEEDS_WORK_RE = /\b(todo|wip|incomplete|missing|broken|fails?|error|bug|revise|adjust|fix(?:ed)?\s+needed|not done|still open|needs changes|needs correction|course[- ]?correct)\b/i;
const DONE_RE = /\b(done|complete(?:d)?|fixed|implemented|works?|passing tests?|tests pass|verified|looks good|merged)\b/i;

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

const TOKEN_ACTION_RE = /^(?:revoke|revok|rotate|rotat|reset|invalidat|regenerat|regenerate|exfiltrate|exfiltrat|expos|expose|hardcod|hardcode|paste|share|send|commit|storing|store|stored|stor|delete|delet|remove|remov|print|dump|disclos|disclose|copi|copy|export|import|leak)(?:ed|ing|s|es|e|ion|ions)?$/;
const TOKEN_DIRECT_ACTION_RE = /^(?:revoke|revok|rotate|rotat|reset|invalidat|regenerat|regenerate|exfiltrate|exfiltrat|expos|expose|hardcod|hardcode|paste|share|send|delet|delete|copi|copy|export|import|remove|stor|store|commit|print|dump|disclos|disclose|leak)(?:ed|ing|s|es|e)?$/;
const TOKEN_DIRECT_ACTION_REQUIRES_CONTEXT_PREFIXES = ["copy", "export", "import", "remove", "store"];
const TOKEN_CONTEXT_PREFIXES = ["api", "access", "hf", "hugging", "face", "github", "gitlab", "secret", "credential", "personal", "pat", "oauth", "bearer", "auth", "env", "environment", "dotenv", "openai", "anthropic", "azure", "aws", "gcp", "service", "compromis", "compromised", "stale", "leaked", "exposed", "exposure", "key"];
const HISTORICAL_TOKEN_RE = /\b(previously|prior|history|historical|thread|earlier)\b/i;

function isSafetySensitive(text: string): boolean {
  const lower = String(text ?? "").toLowerCase();
  const hasTokenWord = /\btokens?\b/i.test(lower);
  if (!SAFETY_RE.test(text) && !hasTokenWord) return false;

  const hasNonTokenSafetySignal = /\b(rm\s+-rf|sudo|shutdown|reboot|mkfs|chown|chmod\s+-R|git\s+push\b[\s\S]*--force(?:-with-lease)?|curl\b[\s\S]*\|\s*(?:sh|bash)\b|wget\b[\s\S]*\|\s*(?:sh|bash)\b|drop\s+table|delete\s+database|credential|password|secret)\b/i.test(lower);
  if (SAFETY_RE.test(text) && hasNonTokenSafetySignal) return true;

  if (!hasTokenWord) return true;

  const hasTokenAction = hasTokenCredentialAction(lower);
  if (!hasTokenAction) return false;

  const historicalTokenMention = isHistoricalTokenMention(lower);
  if (!historicalTokenMention) return true;

  return hasActiveHistoricalTokenAction(lower);
}

function hasTokenCredentialAction(lower: string): boolean {
  return detectTokenCredentialAction(lower).hasAny;
}

function hasActiveHistoricalTokenAction(lower: string): boolean {
  return detectTokenCredentialAction(lower).hasActiveDirect;
}

function detectTokenCredentialAction(lower: string): { hasAny: boolean; hasActiveDirect: boolean } {
  if (!/\btokens?\b/i.test(lower)) return { hasAny: false, hasActiveDirect: false };

  const words = lower.match(/[a-z0-9_]+/g) ?? [];
  const tokenIndexes = words.reduce<number[]>((acc, word, index) => {
    if (/^tokens?$/.test(word)) acc.push(index);
    return acc;
  }, []);
  if (!tokenIndexes.length) return { hasAny: false, hasActiveDirect: false };

  const wordWindow = 8;
  const tokenOnlyWord = tokenIndexes.length === 1 && words.length === 1;
  if (tokenOnlyWord) return { hasAny: false, hasActiveDirect: false };

  let hasAny = false;
  let hasActiveDirect = false;

  for (const tokenIndex of tokenIndexes) {
    const start = Math.max(0, tokenIndex - wordWindow);
    const end = Math.min(words.length, tokenIndex + wordWindow + 1);
    let hasContextualAction = false;
    let hasContext = false;
    let hasPotentialActiveContextualAction = false;

    for (let i = start; i < end; i++) {
      const word = words[i];
      const isRotationNoun = word === "rotation";
      if (TOKEN_DIRECT_ACTION_RE.test(word)) {
        const requiresContext = TOKEN_DIRECT_ACTION_REQUIRES_CONTEXT_PREFIXES.some((prefix) => word.startsWith(prefix));
        if (requiresContext) {
          hasContextualAction = true;
          if (!word.endsWith("ed")) hasPotentialActiveContextualAction = true;
          if (hasContext && !word.endsWith("ed")) {
            hasAny = true;
            hasActiveDirect = true;
          }
          continue;
        }

        hasAny = true;
        if (!word.endsWith("ed")) hasActiveDirect = true;
        continue;
      }
      if (isRotationNoun) {
        hasContextualAction = true;
        if (hasContext) {
          hasAny = true;
        }
        continue;
      }
      if (TOKEN_ACTION_RE.test(word)) hasContextualAction = true;
      if (TOKEN_CONTEXT_PREFIXES.some((prefix) => word.startsWith(prefix))) hasContext = true;
      if (hasContext && hasContextualAction) {
        hasAny = true;
        if (hasPotentialActiveContextualAction) hasActiveDirect = true;
      }
    }
  }

  return { hasAny, hasActiveDirect };
}

function isHistoricalTokenMention(lower: string): boolean {
  if (!/\btokens?\b/i.test(lower)) return false;
  if (!HISTORICAL_TOKEN_RE.test(lower)) return false;
  return /\b(?:hf|hugging\s*face)\b/i.test(lower);
}

function hasQuickEditSignal(text: string): boolean {
  return QUICK_EDIT_RE.test(text);
}

function hasRoutineCleanupSignal(text: string): boolean {
  return ROUTINE_CLEANUP_RE.test(text);
}

function hasComplexSignal(text: string): boolean {
  return COMPLEX_RE.test(text) || DEBUG_RE.test(text);
}

function hasMaterialStuckSignal(text: string): boolean {
  if (!STUCK_RE.test(text)) return false;
  return /\b(goal|loop|autoresearch|tool|test|command|failure|failed|turns?|again|same|repeated|concrete|progress|blocked|alternative|recovery)\b/i.test(text);
}

function hasCompactionLowRiskSignal(text: string): boolean {
  return COMPACTION_RE.test(text) && /\blow[- ]?risk\b/i.test(text);
}

function hasReassuranceOnlySignal(text: string): boolean {
  return REASSURANCE_RE.test(text) && !/\b(material|flip|decision|risk|uncertain|flip the decision)\b/i.test(text);
}

function hasCheckpointSignal(text: string): boolean {
  return CHECKPOINT_RE.test(text) && !/\b(risky|security|irreversible|unknown dependency|hidden dependency)\b/i.test(text);
}

function hasCheapSignalMaterialSignal(text: string): boolean {
  return CHEAP_SIGNAL_RE.test(text) && /\b(materially|flip the decision|decision-changing|materially changes|could change|main model is useless|main model already gives a solid answer|solid answer)\b/i.test(text);
}

function hasCheapSignalIrrelevantSignal(text: string): boolean {
  return CHEAP_SIGNAL_RE.test(text) && /\b(should not change|shouldn'?t change|not materially|already gives a solid answer|solid answer)\b/i.test(text);
}

function needsContext(text: string): boolean {
  return CONTEXT_RE.test(text) || text.trim().length < 18 || text.trim().split(/\s+/).length < 4;
}

function reviewSignals(input: AdvisorRouteInput): { label: ReviewLabel; confidence: number; reason: string } {
  const text = `${input.text}\n${input.brief ?? ""}`.trim();
  if (input.failed) {
    return { label: "not_done", confidence: 0.95, reason: "Turn reported failure." };
  }
  if (input.phase === "closeout" && CLOSEOUT_RE.test(text)) {
    return { label: /\bnot[- ]?done\b/i.test(text) ? "not_done" : "course_correct", confidence: 0.86, reason: "Closeout judgment requested." };
  }
  if (REVIEW_NEEDS_WORK_RE.test(text)) {
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
  if (hasMaterialStuckSignal(text)) {
    return { label: "escalate_to_advisor", confidence: 0.86, reason: "Material stuck/no-progress signal detected.", safety: false };
  }
  if (hasRoutineCleanupSignal(text) || (hasQuickEditSignal(text) && !hasComplexSignal(text))) {
    return { label: "continue", confidence: 0.9, reason: "Small-edit or routine-cleanup signal detected.", safety: false };
  }
  if (hasCompactionLowRiskSignal(text)) {
    return { label: "continue", confidence: 0.84, reason: "Low-risk compaction boundary; advisor not needed.", safety: false };
  }
  if (hasReassuranceOnlySignal(text) || hasCheckpointSignal(text) || hasCheapSignalIrrelevantSignal(text)) {
    return { label: "continue", confidence: 0.82, reason: "Main model should handle this without advisor.", safety: false };
  }
  if (hasCheapSignalMaterialSignal(text) || /\b(advisor-router|advisor flow|advisor routing|router logic|call vs skip|skip vs call|compare|recommend|benchmark|evaluate|experiment|train|research)\b/i.test(text)) {
    return { label: "escalate_to_advisor", confidence: 0.88, reason: "Advisor-specific or decision-changing work detected.", safety: false };
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
        "Guidance: continue for tiny edits, direct answers, docs/formatting cleanup, and other low-risk reactive tasks; escalate_to_advisor for architecture, refactors, design, tradeoffs, security, irreversible actions, high uncertainty, or material stuck/no-progress evidence; need_more_context when underspecified; low_confidence when mixed signals. If advisor guidance conflicts with local evidence, the working model must reconcile explicitly rather than blindly follow it.",
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
    trajectory: route.trajectory,
  };
}

export function appendRouteLog(route: AdvisorRouteDecision): void {
  appendText(ROUTER_LOG_PATH, `${JSON.stringify(routeLogEntry(route))}\n`);
}

export type AdvisorDisplayDecision = "continue" | "review" | "defer";
export type AdvisorDisplayTag = "advisor:model" | "advisor:rules" | "advisor:llm";

function displayDecision(route: AdvisorRouteDecision): AdvisorDisplayDecision {
  if (route.phase === "preflight") {
    switch (route.label as PreflightLabel) {
      case "continue": return "continue";
      case "escalate_to_advisor": return "review";
      case "need_more_context": return "defer";
      case "low_confidence": return "defer";
    }
  }

  switch (route.label as ReviewLabel) {
    case "on_track": return "continue";
    case "course_correct": return "review";
    case "not_done": return "review";
    case "abstain": return "defer";
  }
}

function displayTag(route: AdvisorRouteDecision | AdvisorDisplayTag): AdvisorDisplayTag {
  if (typeof route === "string") return route;
  switch (route.source) {
    case "model": return "advisor:model";
    case "llm": return "advisor:llm";
    default: return "advisor:rules";
  }
}

export function formatAdvisorDisplay(tag: AdvisorDisplayTag, decision: AdvisorDisplayDecision, explanation: string): string {
  const text = squish(explanation || "no extra detail", 140).toLowerCase();
  return `[${tag}: ${decision}, reason: ${text}]`;
}

export function routeNote(route: AdvisorRouteDecision): string {
  const explanation = route.reason || (route.phase === "preflight"
    ? route.label === "continue"
      ? "routine work can continue without advisor attention"
      : route.label === "escalate_to_advisor"
        ? "complex or high-risk work needs advisor review"
        : route.label === "need_more_context"
          ? "more context is needed before routing confidently"
          : "signal is mixed, so defer the decision"
    : route.label === "on_track"
      ? "work looks on track and can continue"
      : route.label === "course_correct"
        ? "work is progressing but needs review"
        : route.label === "not_done"
          ? "work is incomplete or failing and needs review"
          : "review signal is too weak to decide");
  return formatAdvisorDisplay(displayTag(route), displayDecision(route), explanation);
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
