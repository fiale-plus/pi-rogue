import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decideRoute, readCheckpointJsonl } from "./decision.js";
import { hashText } from "./hash.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import { readOutcomes, type RouterOutcome } from "./outcomes.js";
import type { RouteAction, RouteDecision, RouterCheckpoint } from "./types.js";

export const MODEL_CAPABILITY_CARD_SCHEMA = "pi-router.model-capability-card.v1" as const;
export const MODEL_CAPABILITY_CARD_SCHEMA_V2 = "pi-router.model-capability-card.v2" as const;
export const TEACHER_LABEL_SCHEMA = "pi-router.teacher-label.v1" as const;
export const SHADOW_EVAL_SCHEMA = "pi-router.shadow-eval.v1" as const;

export interface ModelCapabilityCard {
  schema: typeof MODEL_CAPABILITY_CARD_SCHEMA;
  modelId: string;
  provider?: string;
  generatedAt: string;
  seed: {
    source: "none" | "manual" | "public" | "default";
    purpose: string;
  };
  observed: {
    source: "local Pi telemetry";
    events: number;
    sessions: number;
    actions: Record<string, number>;
    averageLoopScore: number;
    averageProgressScore: number;
    averageContextTokensApprox: number | null;
    outcomes: {
      linked: number;
      success: number;
      partial: number;
      failed: number;
      abandoned: number;
      unknown: number;
      averageReworkTurns: number | null;
    };
  };
  promotion: {
    manualOnly: true;
    promoted: false;
  };
}

export type CapabilityTier = "local" | "cheap" | "standard" | "premium" | "experimental";

export interface ModelCapabilityMetadata {
  /** Context window in tokens (approximate, rounded to nearest 1024). */
  contextWindow?: number;
  /** Cost per million tokens, structured as { input: number; output: number } in USD. */
  cost?: { input: number; output: number };
  /** Whether the model supports structured reasoning outputs. */
  reasoning?: boolean;
  /** Whether the model is primarily an input model (embedding, classification). */
  inputOnly?: boolean;
  /** Capability tier for cost-aware routing hints. */
  tier?: CapabilityTier;
  /** Free-form tags for structured capability signals (e.g. "multimodal", "vision", "code-generation"). */
  tags?: string[];
}

export interface ModelCapabilityCardV2 {
  schema: typeof MODEL_CAPABILITY_CARD_SCHEMA_V2;
  modelId: string;
  provider?: string;
  generatedAt: string;
  seed: {
    source: "none" | "manual" | "public" | "default";
    purpose: string;
  };
  /** Structured capability/cost metadata for cost-aware routing. */
  capabilities?: ModelCapabilityMetadata;
  observed: {
    source: "local Pi telemetry";
    events: number;
    sessions: number;
    actions: Record<string, number>;
    averageLoopScore: number;
    averageProgressScore: number;
    averageContextTokensApprox: number | null;
    outcomes: {
      linked: number;
      success: number;
      partial: number;
      failed: number;
      abandoned: number;
      unknown: number;
      averageReworkTurns: number | null;
    };
  };
  promotion: {
    manualOnly: true;
    promoted: false;
  };
}

/** Union type for all card versions; consumers should check schema to discriminate. */
export type ModelCapabilityCardAny = ModelCapabilityCard | ModelCapabilityCardV2;

/** Type guard: is this a v2 card with capabilities metadata? */
export function isV2Card(card: ModelCapabilityCardAny): card is ModelCapabilityCardV2 {
  return card.schema === MODEL_CAPABILITY_CARD_SCHEMA_V2;
}

/** Extract tier from v2 card capabilities, falling back to heuristic if unavailable. */
export function getCardTier(card: ModelCapabilityCardAny): CapabilityTier | undefined {
  if (isV2Card(card) && card.capabilities?.tier) return card.capabilities.tier;
  return undefined;
}

/** Extract cost metadata from v2 card capabilities. */
export function getCardCost(card: ModelCapabilityCardAny): { input: number; output: number } | undefined {
  if (isV2Card(card) && card.capabilities?.cost) return card.capabilities.cost;
  return undefined;
}

/** Extract context window from v2 card capabilities. */
export function getCardContextWindow(card: ModelCapabilityCardAny): number | undefined {
  if (isV2Card(card) && card.capabilities?.contextWindow) return card.capabilities.contextWindow;
  return undefined;
}

export interface TeacherLabel {
  schema: typeof TEACHER_LABEL_SCHEMA;
  labelId: string;
  generatedAt: string;
  teacher: string;
  checkpointId: string;
  sessionId: string;
  rawSessionRef: RouterCheckpoint["rawSessionRef"];
  suggestedAction: RouteAction;
  confidence: number;
  rationale: string;
  source: "local-rule" | "teacher-output";
}

export interface TeacherPromptRequest {
  schema: "pi-router.teacher-prompt.v1";
  requestId: string;
  teacher: string;
  checkpointId: string;
  sessionId: string;
  rawSessionRef: RouterCheckpoint["rawSessionRef"];
  allowedActions: RouteAction[];
  instruction: string;
  features: Pick<RouterCheckpoint, "phase" | "activeModel" | "provider"> & {
    loopScore: number;
    progressScore: number;
    sameCommandRepeatedCount: number;
    sameErrorRepeatedCount: number;
    verifierUsed: boolean;
    noVerifierUsed: boolean;
    diffLines: number;
    diffFilesChanged: number;
  };
}

export interface ReflectionResult {
  labels: TeacherLabel[];
  markdown: string;
}

export interface ShadowEvalReport {
  schema: typeof SHADOW_EVAL_SCHEMA;
  generatedAt: string;
  policyVersion: string;
  checkpoints: number;
  comparedEvents: number;
  actionCounts: Record<string, number>;
  ledgerActionCounts: Record<string, number>;
  divergences: number;
  divergenceRate: number;
  likelySavingsSignals: {
    summarizeContext: number;
    runVerifier: number;
    continueCurrent: number;
  };
  manualPromotionRequired: true;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function writeJsonl(path: string, rows: unknown[]): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function emptyOutcomeCounts(): ModelCapabilityCard["observed"]["outcomes"] {
  return { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null };
}

function summarizeOutcomes(group: RouteEvent[], outcomes: RouterOutcome[]): ModelCapabilityCard["observed"]["outcomes"] {
  const byRouteEvent = new Map(outcomes.flatMap((outcome) => outcome.routeEventId ? [[outcome.routeEventId, outcome] as const] : []));
  const byCheckpoint = new Map(outcomes.flatMap((outcome) => outcome.checkpointId && !outcome.routeEventId ? [[outcome.checkpointId, outcome] as const] : []));
  const linked = group.flatMap((event) => {
    const outcome = byRouteEvent.get(event.eventId) ?? byCheckpoint.get(event.checkpointId);
    return outcome ? [outcome] : [];
  });
  if (linked.length === 0) return emptyOutcomeCounts();
  const counts = emptyOutcomeCounts();
  counts.linked = linked.length;
  for (const outcome of linked) counts[outcome.taskStatus]++;
  const reworkValues = linked.map((outcome) => outcome.reworkTurns).filter((value): value is number => Number.isFinite(value));
  counts.averageReworkTurns = reworkValues.length ? round(reworkValues.reduce((sum, value) => sum + value, 0) / reworkValues.length) : null;
  return counts;
}

/**
 * Map of known model patterns to v2 capabilities metadata.
 * This is the structured replacement for the old isLocalOrCheap regex heuristics.
 */
const MODEL_CAPABILITIES_MAP: Record<string, Partial<ModelCapabilityMetadata>> = {
  "local": { tier: "local", contextWindow: 131072, tags: ["local"] },
  "ollama": { tier: "local", tags: ["local", "ollama"] },
  "mlx": { tier: "local", tags: ["local", "mlx"] },
  "qwen": { tier: "cheap", cost: { input: 0.0003, output: 0.0006 }, tags: ["cheap", "qwen"] },
  "llama": { tier: "cheap", cost: { input: 0.0002, output: 0.0004 }, tags: ["cheap", "llama"] },
  "mistral": { tier: "cheap", cost: { input: 0.0002, output: 0.0004 }, tags: ["cheap", "mistral"] },
  "phi": { tier: "cheap", cost: { input: 0.0001, output: 0.0002 }, tags: ["cheap", "phi"] },
  "codex-spark": { tier: "cheap", cost: { input: 0.0005, output: 0.001 }, tags: ["cheap", "codex-spark"] },
  "spark": { tier: "cheap", cost: { input: 0.0003, output: 0.0006 }, tags: ["cheap", "spark"] },
  "gpt": { tier: "premium", cost: { input: 0.01, output: 0.03 }, tags: ["premium", "gpt"] },
  "claude": { tier: "premium", cost: { input: 0.008, output: 0.024 }, tags: ["premium", "claude"] },
  "gemini": { tier: "standard", cost: { input: 0.000125, output: 0.0005 }, tags: ["standard", "gemini"] },
  "deepseek": { tier: "cheap", cost: { input: 0.000014, output: 0.000028 }, tags: ["cheap", "deepseek"] },
};

function resolveCapabilitiesForModel(modelId: string, provider: string): ModelCapabilityMetadata | undefined {
  const providerLower = (provider ?? "").toLowerCase();
  const modelLower = modelId.toLowerCase();
  for (const [pattern, capabilities] of Object.entries(MODEL_CAPABILITIES_MAP)) {
    if (providerLower.includes(pattern) || modelLower.includes(pattern)) {
      return capabilities as ModelCapabilityMetadata;
    }
  }
  // Default: standard tier with no cost info
  return undefined;
}

export function generateCapabilityCards(events: RouteEvent[], generatedAt = new Date().toISOString(), outcomes: RouterOutcome[] = []): ModelCapabilityCardV2[] {
  const groups = new Map<string, RouteEvent[]>();
  for (const event of events) {
    const modelId = event.runtime.activeModel ?? "unknown";
    const provider = event.runtime.provider ?? "unknown";
    const key = `${provider}\0${modelId}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const [provider, modelId] = key.split("\0");
    const actions: Record<string, number> = {};
    const sessions = new Set(group.map((event) => event.sessionId));
    const contextValues = group
      .map((event) => event.runtime.contextTokensApprox)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    for (const event of group) increment(actions, event.decision.action);
    const capabilities = resolveCapabilitiesForModel(modelId, provider);
    return {
      schema: MODEL_CAPABILITY_CARD_SCHEMA_V2,
      modelId,
      provider,
      generatedAt,
      capabilities,
      seed: {
        source: "none",
        purpose: "cold-start priors are intentionally absent in v0; local observations dominate",
      },
      observed: {
        source: "local Pi telemetry",
        events: group.length,
        sessions: sessions.size,
        actions,
        averageLoopScore: round(group.reduce((sum, event) => sum + event.metrics.loopScore, 0) / group.length),
        averageProgressScore: round(group.reduce((sum, event) => sum + event.metrics.progressScore, 0) / group.length),
        averageContextTokensApprox: contextValues.length
          ? round(contextValues.reduce((sum, value) => sum + value, 0) / contextValues.length)
          : null,
        outcomes: summarizeOutcomes(group, outcomes),
      },
      promotion: {
        manualOnly: true,
        promoted: false,
      },
    } satisfies ModelCapabilityCardV2;
  }).sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`));
}

function readRequiredRouteEvents(path: string): RouteEvent[] {
  if (!existsSync(resolve(path))) throw new Error(`required route events file not found: ${path}`);
  return readRouteEvents(path);
}

export function writeCapabilityCards(eventsPath: string, outputPath: string, outcomesPath?: string): ModelCapabilityCardV2[] {
  const cards = generateCapabilityCards(readRequiredRouteEvents(eventsPath), new Date().toISOString(), readOutcomes(outcomesPath));
  writeJsonl(outputPath, cards);
  return cards;
}

function labelFromDecision(
  checkpoint: RouterCheckpoint,
  decision: RouteDecision,
  teacher: string,
  source: TeacherLabel["source"],
  generatedAt: string,
): TeacherLabel {
  return {
    schema: TEACHER_LABEL_SCHEMA,
    labelId: hashText(teacher, checkpoint.checkpointId, decision.action, checkpoint.rawSessionRef.contentHash),
    generatedAt,
    teacher,
    checkpointId: checkpoint.checkpointId,
    sessionId: checkpoint.sessionId,
    rawSessionRef: checkpoint.rawSessionRef,
    suggestedAction: decision.action,
    confidence: decision.confidence,
    rationale: decision.reason,
    source,
  };
}

export function readTeacherLabels(path: string): TeacherLabel[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TeacherLabel);
}

function importedTeacherDecisions(path: string): Map<string, RouteDecision> {
  const map = new Map<string, RouteDecision>();
  if (!path) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const decision = JSON.parse(line) as RouteDecision;
    map.set(decision.checkpointId, decision);
  }
  return map;
}

export function generateTeacherReflection(
  checkpoints: RouterCheckpoint[],
  options: { teacher: string; teacherOutputPath?: string; generatedAt?: string } = { teacher: "local-rule" },
): ReflectionResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (options.teacher !== "local-rule" && !options.teacherOutputPath) {
    throw new Error("non-local teacher reflection requires --teacher-output decisions JSONL in local-only v0");
  }
  const imported = options.teacherOutputPath ? importedTeacherDecisions(options.teacherOutputPath) : new Map<string, RouteDecision>();
  const labels = checkpoints.map((checkpoint) => {
    const importedDecision = imported.get(checkpoint.checkpointId);
    if (options.teacher !== "local-rule" && !importedDecision) {
      throw new Error(`teacher output missing decision for checkpoint: ${checkpoint.checkpointId}`);
    }
    const decision = importedDecision ?? decideRoute(checkpoint, { policyVersion: options.teacher });
    const source: TeacherLabel["source"] = importedDecision ? "teacher-output" : "local-rule";
    return labelFromDecision(checkpoint, decision, options.teacher, source, generatedAt);
  });
  const actionCounts: Record<string, number> = {};
  for (const label of labels) increment(actionCounts, label.suggestedAction);
  const markdown = [
    `# Pi router teacher reflection`,
    ``,
    `- generatedAt: ${generatedAt}`,
    `- teacher: ${options.teacher}`,
    `- labels: ${labels.length}`,
    `- source: ${options.teacherOutputPath ? "imported teacher output" : "local rule teacher"}`,
    ``,
    `## Suggested action counts`,
    ``,
    ...Object.entries(actionCounts).sort().map(([action, count]) => `- ${action}: ${count}`),
    ``,
    `Manual promotion only: these labels do not mutate router policy.`,
  ].join("\n");
  return { labels, markdown };
}

export function generateTeacherPromptRequests(checkpoints: RouterCheckpoint[], teacher: string): TeacherPromptRequest[] {
  const allowedActions: RouteAction[] = [
    "continue_current",
    "continue_local",
    "summarize_context",
    "run_verifier",
    "ask_micro_hint",
    "escalate_plan_critique",
    "escalate_debug_diagnosis",
    "escalate_diff_review",
    "delegate_full_step",
    "spawn_subagent",
    "stop_and_ask_user",
  ];
  return checkpoints.map((checkpoint) => ({
    schema: "pi-router.teacher-prompt.v1",
    requestId: hashText("teacher-request", teacher, checkpoint.checkpointId, checkpoint.rawSessionRef.contentHash),
    teacher,
    checkpointId: checkpoint.checkpointId,
    sessionId: checkpoint.sessionId,
    rawSessionRef: checkpoint.rawSessionRef,
    allowedActions,
    instruction: "Inspect the raw session span by pointer if needed. Return one pi-router.decision.v1 JSON object with checkpointId, action, adviceShape, contextPolicy, confidence, reason, and policyVersion. Prefer intervention only when it likely improves trajectory outcome; do not mutate policy.",
    features: {
      phase: checkpoint.phase,
      activeModel: checkpoint.activeModel,
      provider: checkpoint.provider,
      loopScore: checkpoint.features.loopScore,
      progressScore: checkpoint.features.progressScore,
      sameCommandRepeatedCount: checkpoint.features.sameCommandRepeatedCount,
      sameErrorRepeatedCount: checkpoint.features.sameErrorRepeatedCount,
      verifierUsed: checkpoint.features.verifierUsed,
      noVerifierUsed: checkpoint.features.noVerifierUsed,
      diffLines: checkpoint.features.diffLines,
      diffFilesChanged: checkpoint.features.diffFilesChanged,
    },
  }));
}

export function writeTeacherPromptRequests(checkpointPath: string, outputPath: string, teacher: string): TeacherPromptRequest[] {
  const requests = generateTeacherPromptRequests(readCheckpointJsonl(checkpointPath), teacher);
  writeJsonl(outputPath, requests);
  return requests;
}

export function writeTeacherReflection(options: {
  checkpointPath: string;
  labelsPath: string;
  reflectionPath: string;
  teacher: string;
  teacherOutputPath?: string;
  teacherPromptPath?: string;
}): ReflectionResult {
  const checkpoints = readCheckpointJsonl(options.checkpointPath);
  if (options.teacherPromptPath) writeJsonl(options.teacherPromptPath, generateTeacherPromptRequests(checkpoints, options.teacher));
  const reflection = generateTeacherReflection(checkpoints, {
    teacher: options.teacher,
    teacherOutputPath: options.teacherOutputPath,
  });
  writeJsonl(options.labelsPath, reflection.labels);
  const resolved = resolve(options.reflectionPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${reflection.markdown}\n`);
  return reflection;
}

export function shadowEvaluate(checkpoints: RouterCheckpoint[], ledgerEvents: RouteEvent[] = [], generatedAt = new Date().toISOString()): ShadowEvalReport {
  const ledgerByCheckpoint = new Map(ledgerEvents.map((event) => [event.checkpointId, event]));
  const actionCounts: Record<string, number> = {};
  const ledgerActionCounts: Record<string, number> = {};
  let comparedEvents = 0;
  let divergences = 0;
  let summarizeContext = 0;
  let runVerifier = 0;
  let continueCurrent = 0;

  for (const checkpoint of checkpoints) {
    const decision = decideRoute(checkpoint);
    increment(actionCounts, decision.action);
    if (decision.action === "summarize_context") summarizeContext++;
    if (decision.action === "run_verifier") runVerifier++;
    if (decision.action === "continue_current") continueCurrent++;
    const actual = ledgerByCheckpoint.get(checkpoint.checkpointId);
    if (!actual) continue;
    comparedEvents++;
    increment(ledgerActionCounts, actual.decision.action);
    if (actual.decision.action !== decision.action) divergences++;
  }

  return {
    schema: SHADOW_EVAL_SCHEMA,
    generatedAt,
    policyVersion: checkpoints[0] ? decideRoute(checkpoints[0]).policyVersion : "pi-router.rule-policy.v0",
    checkpoints: checkpoints.length,
    comparedEvents,
    actionCounts,
    ledgerActionCounts,
    divergences,
    divergenceRate: comparedEvents ? round(divergences / comparedEvents) : 0,
    likelySavingsSignals: { summarizeContext, runVerifier, continueCurrent },
    manualPromotionRequired: true,
  };
}

export function writeShadowEval(checkpointPath: string, outputPath: string, ledgerPath?: string): ShadowEvalReport {
  const report = shadowEvaluate(readCheckpointJsonl(checkpointPath), ledgerPath ? readRequiredRouteEvents(ledgerPath) : []);
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
