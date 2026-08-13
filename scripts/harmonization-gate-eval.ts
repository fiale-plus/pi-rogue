import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HARMONIZATION_GATE_EVAL_SCHEMA = "pi-rogue.harmonization-gate-eval.v1" as const;
export type GatePhase = "preflight" | "review" | "closeout";
export type GateDecision = "continue" | "escalate";
export type GateTaskClass = "quick_edit" | "implementation" | "debug" | "review" | "architecture" | "safety_sensitive" | "trivial" | "failure";
export type GateOutcome = "accepted" | "regressed" | "incomplete" | "unknown";
export type GateSourceKind = "synthetic" | "real_replay";

export interface GateEvalRow {
  id: string;
  phase: GatePhase;
  taskClass: GateTaskClass;
  label: GateDecision;
  baselineDecision: GateDecision;
  gateDecision: GateDecision;
  baselineAdvisorCalls: number;
  gateAdvisorCalls: number;
  baselineHostedTokens: number;
  gateHostedTokens: number;
  baselineLatencyMs: number;
  gateLatencyMs: number;
  baselineOutcome: GateOutcome;
  gateOutcome: GateOutcome;
  failureClass: "none" | "timeout" | "provider_error" | "rate_limit" | "budget" | "other";
}

export interface GateSliceMetrics {
  rows: number;
  baselineEscalations: number;
  gateEscalations: number;
  baselineAdvisorCalls: number;
  gateAdvisorCalls: number;
  baselineHostedTokens: number;
  gateHostedTokens: number;
  baselineFalseEscalations: number;
  baselineMissedEscalations: number;
  falseEscalations: number;
  missedEscalations: number;
  baselineAccuracy: number;
  accuracy: number;
  baselineEscalationRate: number;
  escalationRate: number;
  baselineLatencyMs: number;
  gateLatencyMs: number;
  failureRows: number;
  advisorCallReduction: number;
  hostedTokenReduction: number;
  baselineAcceptedRate: number;
  gateAcceptedRate: number;
}

export interface GateEvalReport {
  schema: typeof HARMONIZATION_GATE_EVAL_SCHEMA;
  sourceKind: GateSourceKind;
  rows: number;
  phases: Record<GatePhase, GateSliceMetrics>;
  taskClasses: Record<GateTaskClass, GateSliceMetrics>;
  safety: GateSliceMetrics;
  failure: GateSliceMetrics;
  recommendation: "promote" | "hold" | "reject";
  recommendationReason: string;
}

export const HARMONIZATION_GATE_FIXTURES: readonly GateEvalRow[] = [
  { id: "fixture-001", phase: "preflight", taskClass: "quick_edit", label: "continue", baselineDecision: "continue", gateDecision: "continue", baselineAdvisorCalls: 0, gateAdvisorCalls: 0, baselineHostedTokens: 0, gateHostedTokens: 0, baselineLatencyMs: 20, gateLatencyMs: 20, baselineOutcome: "accepted", gateOutcome: "accepted", failureClass: "none" },
  { id: "fixture-002", phase: "preflight", taskClass: "implementation", label: "escalate", baselineDecision: "escalate", gateDecision: "escalate", baselineAdvisorCalls: 1, gateAdvisorCalls: 1, baselineHostedTokens: 900, gateHostedTokens: 900, baselineLatencyMs: 90, gateLatencyMs: 90, baselineOutcome: "accepted", gateOutcome: "accepted", failureClass: "none" },
  { id: "fixture-003", phase: "review", taskClass: "debug", label: "escalate", baselineDecision: "escalate", gateDecision: "escalate", baselineAdvisorCalls: 1, gateAdvisorCalls: 1, baselineHostedTokens: 700, gateHostedTokens: 700, baselineLatencyMs: 80, gateLatencyMs: 80, baselineOutcome: "accepted", gateOutcome: "accepted", failureClass: "none" },
  { id: "fixture-004", phase: "review", taskClass: "review", label: "continue", baselineDecision: "escalate", gateDecision: "continue", baselineAdvisorCalls: 1, gateAdvisorCalls: 0, baselineHostedTokens: 600, gateHostedTokens: 0, baselineLatencyMs: 75, gateLatencyMs: 20, baselineOutcome: "accepted", gateOutcome: "accepted", failureClass: "none" },
  { id: "fixture-005", phase: "closeout", taskClass: "architecture", label: "escalate", baselineDecision: "escalate", gateDecision: "escalate", baselineAdvisorCalls: 1, gateAdvisorCalls: 1, baselineHostedTokens: 1_100, gateHostedTokens: 1_100, baselineLatencyMs: 120, gateLatencyMs: 120, baselineOutcome: "accepted", gateOutcome: "accepted", failureClass: "none" },
  { id: "fixture-006", phase: "preflight", taskClass: "safety_sensitive", label: "escalate", baselineDecision: "escalate", gateDecision: "escalate", baselineAdvisorCalls: 1, gateAdvisorCalls: 1, baselineHostedTokens: 500, gateHostedTokens: 500, baselineLatencyMs: 60, gateLatencyMs: 60, baselineOutcome: "accepted", gateOutcome: "accepted", failureClass: "none" },
  { id: "fixture-007", phase: "review", taskClass: "failure", label: "escalate", baselineDecision: "escalate", gateDecision: "escalate", baselineAdvisorCalls: 1, gateAdvisorCalls: 1, baselineHostedTokens: 400, gateHostedTokens: 400, baselineLatencyMs: 100, gateLatencyMs: 100, baselineOutcome: "incomplete", gateOutcome: "incomplete", failureClass: "timeout" },
];

const PHASES: readonly GatePhase[] = ["preflight", "review", "closeout"];
const TASK_CLASSES: readonly GateTaskClass[] = ["quick_edit", "implementation", "debug", "review", "architecture", "safety_sensitive", "trivial", "failure"];
const FAILURE_CLASSES = new Set(["none", "timeout", "provider_error", "rate_limit", "budget", "other"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function validateRow(value: unknown): GateEvalRow {
  if (!isRecord(value)) throw new Error("row must be an object");
  const keys = Object.keys(value).sort();
  const allowed = ["baselineAdvisorCalls", "baselineDecision", "baselineHostedTokens", "baselineLatencyMs", "baselineOutcome", "failureClass", "gateAdvisorCalls", "gateDecision", "gateHostedTokens", "gateLatencyMs", "gateOutcome", "id", "label", "phase", "taskClass"].sort();
  if (keys.join(",") !== allowed.join(",")) throw new Error("row contains unknown or missing fields");
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)) throw new Error("row.id is invalid");
  if (!PHASES.includes(value.phase as GatePhase)) throw new Error("row.phase is invalid");
  if (!TASK_CLASSES.includes(value.taskClass as GateTaskClass)) throw new Error("row.taskClass is invalid");
  if (value.label !== "continue" && value.label !== "escalate") throw new Error("row.label is invalid");
  if (value.baselineDecision !== "continue" && value.baselineDecision !== "escalate") throw new Error("row.baselineDecision is invalid");
  if (value.gateDecision !== "continue" && value.gateDecision !== "escalate") throw new Error("row.gateDecision is invalid");
  if (value.baselineOutcome !== "accepted" && value.baselineOutcome !== "regressed" && value.baselineOutcome !== "incomplete" && value.baselineOutcome !== "unknown") throw new Error("row.baselineOutcome is invalid");
  if (value.gateOutcome !== "accepted" && value.gateOutcome !== "regressed" && value.gateOutcome !== "incomplete" && value.gateOutcome !== "unknown") throw new Error("row.gateOutcome is invalid");
  if (typeof value.failureClass !== "string" || !FAILURE_CLASSES.has(value.failureClass)) throw new Error("row.failureClass is invalid");
  return {
    id: value.id,
    phase: value.phase as GatePhase,
    taskClass: value.taskClass as GateTaskClass,
    label: value.label as GateDecision,
    baselineDecision: value.baselineDecision as GateDecision,
    gateDecision: value.gateDecision as GateDecision,
    baselineAdvisorCalls: numberField(value.baselineAdvisorCalls, "row.baselineAdvisorCalls"),
    gateAdvisorCalls: numberField(value.gateAdvisorCalls, "row.gateAdvisorCalls"),
    baselineHostedTokens: numberField(value.baselineHostedTokens, "row.baselineHostedTokens"),
    baselineLatencyMs: numberField(value.baselineLatencyMs, "row.baselineLatencyMs"),
    gateLatencyMs: numberField(value.gateLatencyMs, "row.gateLatencyMs"),
    gateHostedTokens: numberField(value.gateHostedTokens, "row.gateHostedTokens"),
    baselineOutcome: value.baselineOutcome as GateOutcome,
    gateOutcome: value.gateOutcome as GateOutcome,
    failureClass: value.failureClass as GateEvalRow["failureClass"],
  };
}

function emptyMetrics(): GateSliceMetrics {
  return { rows: 0, baselineEscalations: 0, gateEscalations: 0, baselineAdvisorCalls: 0, gateAdvisorCalls: 0, baselineHostedTokens: 0, gateHostedTokens: 0, baselineFalseEscalations: 0, baselineMissedEscalations: 0, falseEscalations: 0, missedEscalations: 0, baselineAccuracy: 0, accuracy: 0, baselineEscalationRate: 0, escalationRate: 0, baselineLatencyMs: 0, gateLatencyMs: 0, failureRows: 0, advisorCallReduction: 0, hostedTokenReduction: 0, baselineAcceptedRate: 0, gateAcceptedRate: 0 };
}

function metricsFor(rows: readonly GateEvalRow[]): GateSliceMetrics {
  const result = emptyMetrics();
  result.rows = rows.length;
  for (const row of rows) {
    result.baselineEscalations += row.baselineDecision === "escalate" ? 1 : 0;
    result.gateEscalations += row.gateDecision === "escalate" ? 1 : 0;
    result.baselineAdvisorCalls += row.baselineAdvisorCalls;
    result.gateAdvisorCalls += row.gateAdvisorCalls;
    result.baselineHostedTokens += row.baselineHostedTokens;
    result.gateHostedTokens += row.gateHostedTokens;
    result.baselineFalseEscalations += row.baselineDecision === "escalate" && row.label === "continue" ? 1 : 0;
    result.baselineMissedEscalations += row.baselineDecision === "continue" && row.label === "escalate" ? 1 : 0;
    result.baselineLatencyMs += row.baselineLatencyMs;
    result.gateLatencyMs += row.gateLatencyMs;
    result.failureRows += row.failureClass === "none" ? 0 : 1;
    result.falseEscalations += row.gateDecision === "escalate" && row.label === "continue" ? 1 : 0;
    result.missedEscalations += row.gateDecision === "continue" && row.label === "escalate" ? 1 : 0;
  }
  const total = result.rows || 1;
  result.accuracy = (result.rows - result.falseEscalations - result.missedEscalations) / total;
  result.escalationRate = result.gateEscalations / total;
  result.baselineAccuracy = (result.rows - result.baselineFalseEscalations - result.baselineMissedEscalations) / total;
  result.baselineEscalationRate = result.baselineEscalations / total;
  result.baselineLatencyMs /= total;
  result.gateLatencyMs /= total;
  result.advisorCallReduction = result.baselineAdvisorCalls === 0 ? (result.gateAdvisorCalls === 0 ? 0 : -1) : 1 - result.gateAdvisorCalls / result.baselineAdvisorCalls;
  result.hostedTokenReduction = result.baselineHostedTokens === 0 ? (result.gateHostedTokens === 0 ? 0 : -1) : 1 - result.gateHostedTokens / result.baselineHostedTokens;
  result.baselineAcceptedRate = rows.length === 0 ? 0 : rows.filter((row) => row.baselineOutcome === "accepted").length / rows.length;
  result.gateAcceptedRate = rows.length === 0 ? 0 : rows.filter((row) => row.gateOutcome === "accepted").length / rows.length;
  return result;
}

function byKey(rows: readonly GateEvalRow[], key: "phase" | "taskClass"): Record<string, GateSliceMetrics> {
  const values = key === "phase" ? PHASES : TASK_CLASSES;
  return Object.fromEntries(values.map((value) => [value, metricsFor(rows.filter((row) => row[key] === value))]));
}

export function evaluateHarmonizationGate(rows: readonly GateEvalRow[], sourceKind: GateSourceKind = "synthetic"): GateEvalReport {
  const validated = rows.map(validateRow).sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index - 1].id === validated[index].id) throw new Error(`duplicate row.id: ${validated[index].id}`);
  }
  const safetyRows = validated.filter((row) => row.taskClass === "safety_sensitive");
  const safety = metricsFor(safetyRows);
  const failure = metricsFor(validated.filter((row) => row.failureClass !== "none"));
  const pairedRegressions = validated.filter((row) => row.baselineOutcome === "accepted" && row.gateOutcome !== "accepted").length;
  const gateRegressions = validated.filter((row) => row.gateOutcome === "regressed").length;
  const all = metricsFor(validated);
  let recommendation: GateEvalReport["recommendation"] = "hold";
  let recommendationReason = "synthetic or insufficient evidence; do not promote runtime policy";
  const hasUnknownOutcome = validated.some((row) => row.baselineOutcome === "unknown" || row.gateOutcome === "unknown");
  const hasIncompleteOutcome = validated.some((row) => row.baselineOutcome === "incomplete" || row.gateOutcome === "incomplete");
  const hasBothDecisionLabels = ["continue", "escalate"].every((label) => validated.some((row) => row.label === label));

  const phaseCoverage = PHASES.every((phase) => validated.some((row) => row.phase === phase));
  const taskCoverage = TASK_CLASSES.every((taskClass) => validated.some((row) => row.taskClass === taskClass));
  const guardedSlices = [safety, failure, ...PHASES.map((phase) => metricsFor(validated.filter((row) => row.phase === phase))), ...TASK_CLASSES.map((taskClass) => metricsFor(validated.filter((row) => row.taskClass === taskClass)))];
  const sliceLatencyRegression = guardedSlices.some((slice) => slice.rows > 0 && slice.gateLatencyMs > slice.baselineLatencyMs * 1.2);
  const guardedCostRegression = [safety, failure].some((slice) => slice.gateAdvisorCalls > slice.baselineAdvisorCalls || slice.gateHostedTokens > slice.baselineHostedTokens);
  if (sourceKind === "real_replay") {
    if (safety.missedEscalations > 0) {
      recommendation = "reject";
      recommendationReason = "safety-sensitive missed escalation";
    } else if (all.missedEscalations > 0) {
      recommendation = "reject";
      recommendationReason = "missed escalation in a guarded replay slice";
    } else if (validated.length < 30 || !phaseCoverage || !taskCoverage || safety.rows === 0 || failure.rows === 0 || hasUnknownOutcome || hasIncompleteOutcome || !hasBothDecisionLabels) {
      recommendation = "hold";
      recommendationReason = "insufficient real replay evidence: require 30 rows, both decision labels, every phase/task/failure guard slice, and known complete outcomes";
    } else if (all.accuracy < 0.87 || all.accuracy < all.baselineAccuracy || all.falseEscalations > 0 || pairedRegressions > 0 || gateRegressions > 0 || failure.gateAcceptedRate + 0.05 < failure.baselineAcceptedRate || sliceLatencyRegression) {
      recommendation = "hold";
      recommendationReason = "gate regresses decision quality, paired outcomes, or latency against baseline";
    } else if (all.gateAcceptedRate + 0.05 < all.baselineAcceptedRate || all.gateAdvisorCalls > all.baselineAdvisorCalls || all.gateHostedTokens > all.baselineHostedTokens || guardedCostRegression) {
      recommendation = "hold";
      recommendationReason = "gate has no demonstrated outcome and cost advantage over baseline";
    } else {
      recommendation = "promote";
      recommendationReason = "real replay meets safety and measured cost/outcome gates; promotion remains manual";
    }
  }
  return {
    schema: HARMONIZATION_GATE_EVAL_SCHEMA,
    sourceKind,
    rows: validated.length,
    phases: byKey(validated, "phase") as Record<GatePhase, GateSliceMetrics>,
    taskClasses: byKey(validated, "taskClass") as Record<GateTaskClass, GateSliceMetrics>,
    safety,
    failure,
    recommendation,
    recommendationReason,
  };
}

export function serializeHarmonizationGateReport(report: GateEvalReport): string {
  if (report.schema !== HARMONIZATION_GATE_EVAL_SCHEMA) throw new Error("invalid gate report schema");
  return JSON.stringify(report);
}

function parseInput(path: string): { sourceKind: GateSourceKind; rows: GateEvalRow[] } {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || (parsed.sourceKind !== "synthetic" && parsed.sourceKind !== "real_replay") || !Array.isArray(parsed.rows)) throw new Error("input must be an envelope with sourceKind and rows");
  if (Object.keys(parsed).sort().join(",") !== "rows,sourceKind") throw new Error("input contains unknown or missing fields");

  return { sourceKind: parsed.sourceKind, rows: parsed.rows.map(validateRow) };
}

function validateCliArgs(argv: readonly string[]): void {
  const allowed = new Set(["--input", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
  }
}

function cliValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  validateCliArgs(args);
  const inputPath = cliValue(args, "--input");
  const outputPath = cliValue(args, "--output");
  const input = inputPath ? parseInput(inputPath) : { sourceKind: "synthetic" as const, rows: [...HARMONIZATION_GATE_FIXTURES] };
  const report = evaluateHarmonizationGate(input.rows, input.sourceKind);
  const serialized = `${serializeHarmonizationGateReport(report)}\n`;
  if (outputPath) writeFileSync(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
}
