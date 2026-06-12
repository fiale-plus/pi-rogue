import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decideRoute, readCheckpointJsonl } from "./decision.js";
import { hashText } from "./hash.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import type { RouteAction, RouteDecision, RouterCheckpoint } from "./types.js";

export const MODEL_CAPABILITY_CARD_SCHEMA = "pi-router.model-capability-card.v1" as const;
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
  };
  promotion: {
    manualOnly: true;
    promoted: false;
  };
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

export function generateCapabilityCards(events: RouteEvent[], generatedAt = new Date().toISOString()): ModelCapabilityCard[] {
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
    return {
      schema: MODEL_CAPABILITY_CARD_SCHEMA,
      modelId,
      provider,
      generatedAt,
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
      },
      promotion: {
        manualOnly: true,
        promoted: false,
      },
    } satisfies ModelCapabilityCard;
  }).sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`));
}

function readRequiredRouteEvents(path: string): RouteEvent[] {
  if (!existsSync(resolve(path))) throw new Error(`required route events file not found: ${path}`);
  return readRouteEvents(path);
}

export function writeCapabilityCards(eventsPath: string, outputPath: string): ModelCapabilityCard[] {
  const cards = generateCapabilityCards(readRequiredRouteEvents(eventsPath));
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

export function writeTeacherReflection(options: {
  checkpointPath: string;
  labelsPath: string;
  reflectionPath: string;
  teacher: string;
  teacherOutputPath?: string;
}): ReflectionResult {
  const reflection = generateTeacherReflection(readCheckpointJsonl(options.checkpointPath), {
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
