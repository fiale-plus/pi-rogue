import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decideRoute, readCheckpointJsonl } from "./decision.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import { readOutcomes, type RouterOutcome } from "./outcomes.js";
import type { RouterCheckpoint, RouteAction } from "./types.js";
import { readTeacherLabels, type TeacherLabel } from "./learning.js";

export const ROUTER_TRAINING_ROW_SCHEMA = "pi-router.training-row.v1" as const;

export type BinaryGateLabel = "continue" | "intervene" | "unknown";

export interface RouterTrainingRow {
  schema: typeof ROUTER_TRAINING_ROW_SCHEMA;
  checkpointId: string;
  sessionId: string;
  rawSessionRef: RouterCheckpoint["rawSessionRef"];
  features: {
    phase: RouterCheckpoint["phase"];
    activeModel?: string;
    provider?: string;
    contextTokensApprox: number | null;
    sameCommandRepeatedCount: number;
    sameErrorRepeatedCount: number;
    loopScore: number;
    progressScore: number;
    verifierUsed: boolean;
    noVerifierUsed: boolean;
    diffLines: number;
    diffFilesChanged: number;
    diffChurnScore: number;
    filesTouched: number;
  };
  labels: {
    routeAction: RouteAction | null;
    binaryGate: BinaryGateLabel;
    source: "teacher" | "human" | "outcome" | "local-rule" | "unknown";
    confidence: number | null;
  };
  outcome: {
    taskStatus: RouterOutcome["taskStatus"] | "unknown";
    testsPassedAfter: boolean | null;
    acceptedDiff: boolean | null;
    userOverrodeDecision: boolean | null;
    reworkTurns: number | null;
  };
  provenance: {
    routeEventId?: string;
    teacherLabelId?: string;
    localRuleAction: RouteAction;
    excludedLocalRuleAsTruth: boolean;
  };
}

function routeToGate(action: RouteAction | null | undefined): BinaryGateLabel {
  if (!action) return "unknown";
  return action === "continue_current" || action === "continue_local" ? "continue" : "intervene";
}

function labelSource(label?: TeacherLabel): RouterTrainingRow["labels"]["source"] {
  if (!label) return "unknown";
  if (label.source === "local-rule") return "local-rule";
  return label.teacher === "human" ? "human" : "teacher";
}

export function buildTrainingRows(options: {
  checkpoints: RouterCheckpoint[];
  routeEvents?: RouteEvent[];
  outcomes?: RouterOutcome[];
  labels?: TeacherLabel[];
  includeLocalRuleLabels?: boolean;
}): RouterTrainingRow[] {
  const eventByCheckpoint = new Map((options.routeEvents ?? []).map((event) => [event.checkpointId, event]));
  const outcomeByCheckpoint = new Map((options.outcomes ?? []).flatMap((outcome) => outcome.checkpointId && !outcome.routeEventId ? [[outcome.checkpointId, outcome] as const] : []));
  const outcomeByRouteEvent = new Map((options.outcomes ?? []).flatMap((outcome) => outcome.routeEventId ? [[outcome.routeEventId, outcome] as const] : []));
  const labelByCheckpoint = new Map((options.labels ?? []).map((label) => [label.checkpointId, label]));

  return options.checkpoints.map((checkpoint) => {
    const routeEvent = eventByCheckpoint.get(checkpoint.checkpointId);
    const outcome = (routeEvent ? outcomeByRouteEvent.get(routeEvent.eventId) : undefined) ?? outcomeByCheckpoint.get(checkpoint.checkpointId);
    const teacherLabel = labelByCheckpoint.get(checkpoint.checkpointId);
    const canUseLabel = Boolean(teacherLabel && (options.includeLocalRuleLabels || teacherLabel.source !== "local-rule"));
    const routeAction = canUseLabel ? teacherLabel!.suggestedAction : null;
    const ruleAction = decideRoute(checkpoint).action;
    return {
      schema: ROUTER_TRAINING_ROW_SCHEMA,
      checkpointId: checkpoint.checkpointId,
      sessionId: checkpoint.sessionId,
      rawSessionRef: checkpoint.rawSessionRef,
      features: {
        phase: checkpoint.phase,
        activeModel: checkpoint.activeModel,
        provider: checkpoint.provider,
        contextTokensApprox: checkpoint.features.contextTokensApprox,
        sameCommandRepeatedCount: checkpoint.features.sameCommandRepeatedCount,
        sameErrorRepeatedCount: checkpoint.features.sameErrorRepeatedCount,
        loopScore: checkpoint.features.loopScore,
        progressScore: checkpoint.features.progressScore,
        verifierUsed: checkpoint.features.verifierUsed,
        noVerifierUsed: checkpoint.features.noVerifierUsed,
        diffLines: checkpoint.features.diffLines ?? 0,
        diffFilesChanged: checkpoint.features.diffFilesChanged ?? 0,
        diffChurnScore: checkpoint.features.diffChurnScore ?? 0,
        filesTouched: checkpoint.features.filesTouched,
      },
      labels: {
        routeAction,
        binaryGate: routeToGate(routeAction),
        source: canUseLabel ? labelSource(teacherLabel) : "unknown",
        confidence: canUseLabel ? teacherLabel!.confidence : null,
      },
      outcome: {
        taskStatus: outcome?.taskStatus ?? "unknown",
        testsPassedAfter: outcome?.testsPassedAfter ?? null,
        acceptedDiff: outcome?.acceptedDiff ?? null,
        userOverrodeDecision: outcome?.userOverrodeDecision ?? null,
        reworkTurns: outcome?.reworkTurns ?? null,
      },
      provenance: {
        routeEventId: routeEvent?.eventId,
        teacherLabelId: canUseLabel ? teacherLabel!.labelId : undefined,
        localRuleAction: ruleAction,
        excludedLocalRuleAsTruth: Boolean(teacherLabel?.source === "local-rule" && !options.includeLocalRuleLabels),
      },
    } satisfies RouterTrainingRow;
  });
}

export function writeTrainingRows(options: {
  checkpointPath: string;
  outputPath: string;
  eventsPath?: string;
  outcomesPath?: string;
  labelsPath?: string;
  includeLocalRuleLabels?: boolean;
}): { schema: "pi-router.dataset-summary.v1"; output: string; rows: number; labeledRows: number } {
  if (options.eventsPath && !existsSync(options.eventsPath)) throw new Error(`route events file not found: ${options.eventsPath}`);
  const rows = buildTrainingRows({
    checkpoints: readCheckpointJsonl(options.checkpointPath),
    routeEvents: options.eventsPath ? readRouteEvents(options.eventsPath) : [],
    outcomes: readOutcomes(options.outcomesPath),
    labels: options.labelsPath ? readTeacherLabels(options.labelsPath) : [],
    includeLocalRuleLabels: options.includeLocalRuleLabels,
  });
  const resolved = resolve(options.outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  return {
    schema: "pi-router.dataset-summary.v1",
    output: resolved,
    rows: rows.length,
    labeledRows: rows.filter((row) => row.labels.binaryGate !== "unknown").length,
  };
}
