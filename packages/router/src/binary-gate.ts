import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BinaryGateLabel, RouterTrainingRow } from "./dataset.js";

export const BINARY_GATE_ARTIFACT_SCHEMA = "pi-router.binary-gate-artifact.v1" as const;
export const BINARY_GATE_EVAL_SCHEMA = "pi-router.binary-gate-eval.v1" as const;

export interface BinaryGateArtifact {
  schema: typeof BINARY_GATE_ARTIFACT_SCHEMA;
  generatedAt: string;
  policyVersion: string;
  model: {
    kind: "linear-threshold";
    threshold: number;
    weights: Record<string, number>;
  };
  training: {
    rows: number;
    labeledRows: number;
    positiveIntervene: number;
    negativeContinue: number;
  };
  evaluation: {
    rows: number;
    labeledRows: number;
    positiveIntervene: number;
    negativeContinue: number;
  };
  manualPromotionRequired: true;
}

export interface ConfusionMatrix {
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
}

export interface BinaryGateEvalReport {
  schema: typeof BINARY_GATE_EVAL_SCHEMA;
  generatedAt: string;
  policyVersion: string;
  trainRows: number;
  trainLabeledRows: number;
  evalRows: number;
  evalLabeledRows: number;
  candidate: ConfusionMatrix & { accuracy: number; precision: number; recall: number; f1: number };
  ruleBaseline: ConfusionMatrix & { accuracy: number; precision: number; recall: number; f1: number };
  thresholdSweep: Array<{ threshold: number; trainAccuracy: number; trainF1: number; evalAccuracy: number; evalF1: number }>;
  manualPromotionRequired: true;
}

export interface GateTrainSummary {
  schema: "pi-router.binary-gate-train-summary.v1";
  artifact: string;
  report: string;
  trainRows: number;
  trainLabeledRows: number;
  evalRows: number;
  evalLabeledRows: number;
  threshold: number;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function readTrainingRows(path: string): RouterTrainingRow[] {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`training rows file not found: ${path}`);
  return readFileSync(resolved, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const row = JSON.parse(line) as RouterTrainingRow;
      if (row.schema !== "pi-router.training-row.v1") throw new Error(`invalid training row schema at ${path}:${index + 1}`);
      return row;
    });
}

function scoreRow(row: RouterTrainingRow): number {
  const weights = DEFAULT_WEIGHTS;
  const context = row.features.contextTokensApprox ? Math.min(row.features.contextTokensApprox / 100_000, 1) : 0;
  const diff = Math.min(row.features.diffLines / 600, 1);
  const repeatErrors = Math.min(row.features.sameErrorRepeatedCount / 4, 1);
  const repeatCommands = Math.min(row.features.sameCommandRepeatedCount / 4, 1);
  const noVerifier = row.features.noVerifierUsed ? 1 : 0;
  const lowProgress = 1 - row.features.progressScore;
  const phaseRisk = row.features.phase === "debug" || row.features.phase === "review" ? 0.15 : 0;
  return Math.max(0, Math.min(1,
    weights.bias
    + weights.loopScore * row.features.loopScore
    + weights.lowProgress * lowProgress
    + weights.sameErrorRepeatedCount * repeatErrors
    + weights.sameCommandRepeatedCount * repeatCommands
    + weights.noVerifierUsed * noVerifier
    + weights.diffLines * diff
    + weights.contextPressure * context
    + phaseRisk,
  ));
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  bias: -0.08,
  loopScore: 0.38,
  lowProgress: 0.22,
  sameErrorRepeatedCount: 0.18,
  sameCommandRepeatedCount: 0.08,
  noVerifierUsed: 0.16,
  diffLines: 0.08,
  contextPressure: 0.12,
};

function isIntervene(label: BinaryGateLabel): boolean | null {
  if (label === "intervene") return true;
  if (label === "continue") return false;
  return null;
}

function ruleGate(row: RouterTrainingRow): BinaryGateLabel {
  return row.provenance.localRuleAction === "continue_current" || row.provenance.localRuleAction === "continue_local" ? "continue" : "intervene";
}

function metrics(matrix: ConfusionMatrix): ConfusionMatrix & { accuracy: number; precision: number; recall: number; f1: number } {
  const total = matrix.truePositive + matrix.trueNegative + matrix.falsePositive + matrix.falseNegative;
  const precision = matrix.truePositive + matrix.falsePositive ? matrix.truePositive / (matrix.truePositive + matrix.falsePositive) : 0;
  const recall = matrix.truePositive + matrix.falseNegative ? matrix.truePositive / (matrix.truePositive + matrix.falseNegative) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    ...matrix,
    accuracy: total ? round((matrix.truePositive + matrix.trueNegative) / total) : 0,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
  };
}

function confusion(rows: RouterTrainingRow[], predict: (row: RouterTrainingRow) => BinaryGateLabel): ConfusionMatrix {
  const matrix: ConfusionMatrix = { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  for (const row of rows) {
    const truth = isIntervene(row.labels.binaryGate);
    if (truth === null) continue;
    const predicted = predict(row) === "intervene";
    if (truth && predicted) matrix.truePositive++;
    else if (!truth && !predicted) matrix.trueNegative++;
    else if (!truth && predicted) matrix.falsePositive++;
    else matrix.falseNegative++;
  }
  return matrix;
}

function thresholdValues(): number[] {
  return Array.from({ length: 19 }, (_, index) => round(0.05 + index * 0.05));
}

function usableLabeledRows(rows: RouterTrainingRow[], label: string): RouterTrainingRow[] {
  const labeled = rows.filter((row) => row.labels.binaryGate !== "unknown" && row.labels.source !== "local-rule");
  const positives = labeled.filter((row) => row.labels.binaryGate === "intervene").length;
  const negatives = labeled.filter((row) => row.labels.binaryGate === "continue").length;
  if (labeled.length === 0) throw new Error(`${label} dataset has no usable teacher/human labeled rows`);
  if (positives === 0 || negatives === 0) throw new Error(`${label} dataset must contain both continue and intervene labels`);
  return labeled;
}

function labelCounts(rows: RouterTrainingRow[]): { positiveIntervene: number; negativeContinue: number } {
  return {
    positiveIntervene: rows.filter((row) => row.labels.binaryGate === "intervene").length,
    negativeContinue: rows.filter((row) => row.labels.binaryGate === "continue").length,
  };
}

export function trainBinaryGate(trainRows: RouterTrainingRow[], evalRows: RouterTrainingRow[], generatedAt = new Date().toISOString()): { artifact: BinaryGateArtifact; report: BinaryGateEvalReport } {
  const trainLabeled = usableLabeledRows(trainRows, "training");
  const evalLabeled = usableLabeledRows(evalRows, "eval");
  const trainSweep = thresholdValues().map((threshold) => {
    const result = metrics(confusion(trainLabeled, (row) => scoreRow(row) >= threshold ? "intervene" : "continue"));
    return { threshold, accuracy: result.accuracy, f1: result.f1 };
  });
  const best = trainSweep.reduce((winner, item) => item.f1 > winner.f1 || (item.f1 === winner.f1 && item.accuracy > winner.accuracy) ? item : winner, trainSweep[0]);
  const policyVersion = `pi-router.binary-gate.v1.threshold-${best.threshold}`;
  const trainCounts = labelCounts(trainLabeled);
  const evalCounts = labelCounts(evalLabeled);
  const thresholdSweep = thresholdValues().map((threshold) => {
    const train = metrics(confusion(trainLabeled, (row) => scoreRow(row) >= threshold ? "intervene" : "continue"));
    const evaluation = metrics(confusion(evalLabeled, (row) => scoreRow(row) >= threshold ? "intervene" : "continue"));
    return { threshold, trainAccuracy: train.accuracy, trainF1: train.f1, evalAccuracy: evaluation.accuracy, evalF1: evaluation.f1 };
  });
  const artifact: BinaryGateArtifact = {
    schema: BINARY_GATE_ARTIFACT_SCHEMA,
    generatedAt,
    policyVersion,
    model: { kind: "linear-threshold", threshold: best.threshold, weights: DEFAULT_WEIGHTS },
    training: { rows: trainRows.length, labeledRows: trainLabeled.length, ...trainCounts },
    evaluation: { rows: evalRows.length, labeledRows: evalLabeled.length, ...evalCounts },
    manualPromotionRequired: true,
  };
  const report: BinaryGateEvalReport = {
    schema: BINARY_GATE_EVAL_SCHEMA,
    generatedAt,
    policyVersion,
    trainRows: trainRows.length,
    trainLabeledRows: trainLabeled.length,
    evalRows: evalRows.length,
    evalLabeledRows: evalLabeled.length,
    candidate: metrics(confusion(evalLabeled, (row) => scoreRow(row) >= best.threshold ? "intervene" : "continue")),
    ruleBaseline: metrics(confusion(evalLabeled, ruleGate)),
    thresholdSweep,
    manualPromotionRequired: true,
  };
  return { artifact, report };
}

export function writeBinaryGateTraining(options: { trainingRowsPath: string; evalRowsPath: string; artifactPath: string; reportPath: string }): GateTrainSummary {
  const rows = readTrainingRows(options.trainingRowsPath);
  const evalRows = readTrainingRows(options.evalRowsPath);
  if (resolve(options.trainingRowsPath) === resolve(options.evalRowsPath)) throw new Error("gate training requires a distinct --eval-dataset file for out-of-sample evaluation");
  const { artifact, report } = trainBinaryGate(rows, evalRows);
  mkdirSync(dirname(resolve(options.artifactPath)), { recursive: true });
  mkdirSync(dirname(resolve(options.reportPath)), { recursive: true });
  writeFileSync(resolve(options.artifactPath), `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`);
  return {
    schema: "pi-router.binary-gate-train-summary.v1",
    artifact: resolve(options.artifactPath),
    report: resolve(options.reportPath),
    trainRows: rows.length,
    trainLabeledRows: artifact.training.labeledRows,
    evalRows: evalRows.length,
    evalLabeledRows: artifact.evaluation.labeledRows,
    threshold: artifact.model.threshold,
  };
}
