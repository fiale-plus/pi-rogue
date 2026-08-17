import type { CloseoutRecord, CloseoutStatus } from "./closeout.js";

export const CLOSEOUT_EVALUATION_VERSION = 1;
const MAX_CASES = 500;
const MAX_TASK_CLASS = 80;

export type EvaluationDisposition = "accepted" | "corrected" | "dismissed" | "not_recorded";
export type EvaluationUtility = "helpful" | "neutral" | "harmful" | "not_run";
export type EvaluationSafety = "fail_closed" | "approved" | "unknown";
export type EvaluationResult = Exclude<CloseoutStatus, "open" | "abandoned"> | "unknown";

export type EvaluationObservation = {
  result: EvaluationResult;
  reworkTurns: number;
  validationPasses: number;
  validationFailures: number;
};

export type AdvisorObservation = EvaluationObservation & {
  ran: boolean;
  utility: EvaluationUtility;
  disposition: EvaluationDisposition;
  evidenceBacked: boolean;
  safety: EvaluationSafety;
  latencyMs?: number;
  tokens?: number;
  cost?: number;
};

export type CloseoutEvaluationCase = {
  id: string;
  taskClass: string;
  safetySensitive: boolean;
  closeout: CloseoutRecord;
  baseline: EvaluationObservation;
  advisor: AdvisorObservation;
};

export type EvaluationSlice = {
  taskClass: string;
  samples: number;
  baselineSuccessRate: number;
  advisorSuccessRate: number;
  successDelta: number;
  baselineAverageRework: number;
  advisorAverageRework: number;
  advisorCalls: number;
  advisorHelpfulRate: number;
  evidenceBackedRate: number;
  safetyViolations: number;
};

export type CloseoutEvaluationReport = {
  version: typeof CLOSEOUT_EVALUATION_VERSION;
  samples: number;
  pairedSamples: number;
  baselineOnlySamples: number;
  baselineSuccessRate: number;
  advisorSuccessRate: number;
  successDelta: number;
  baselineAverageRework: number;
  advisorAverageRework: number;
  advisorCalls: number;
  advisorHelpfulRate: number;
  advisorEvidenceBackedRate: number;
  acceptedCalls: number;
  correctedCalls: number;
  dismissedCalls: number;
  averageLatencyMs?: number;
  totalTokens: number;
  totalCost: number;
  safetyViolations: number;
  slices: EvaluationSlice[];
};

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function integer(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function result(value: unknown): EvaluationResult {
  return value === "success" || value === "partial" || value === "failed" ? value : "unknown";
}

function normalizeObservation(raw: unknown): EvaluationObservation {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    result: result(source.result),
    reworkTurns: integer(source.reworkTurns),
    validationPasses: integer(source.validationPasses),
    validationFailures: integer(source.validationFailures),
  };
}

function normalizeAdvisor(raw: unknown): AdvisorObservation {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const disposition = source.disposition === "accepted" || source.disposition === "corrected" || source.disposition === "dismissed" ? source.disposition : "not_recorded";
  const utility = source.utility === "helpful" || source.utility === "neutral" || source.utility === "harmful" ? source.utility : "not_run";
  const safety = source.safety === "fail_closed" || source.safety === "approved" ? source.safety : "unknown";
  const latency = Number(source.latencyMs);
  const tokens = Number(source.tokens);
  const cost = Number(source.cost);
  return {
    ...normalizeObservation(source),
    ran: source.ran === true,
    utility: source.ran === true ? utility : "not_run",
    disposition,
    evidenceBacked: source.evidenceBacked === true,
    safety,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : undefined,
    tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined,
    cost: Number.isFinite(cost) && cost >= 0 ? cost : undefined,
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidObservation(value: unknown, advisor: boolean): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  const required = ["result", "reworkTurns", "validationPasses", "validationFailures"];
  if (!required.every((key) => hasOwn(source, key))) return false;
  return !advisor || ["ran", "utility", "disposition", "evidenceBacked", "safety"].every((key) => hasOwn(source, key));
}

function isValidCloseout(value: unknown): value is CloseoutRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as CloseoutRecord;
  return record.version === 1
    && typeof record.session?.key === "string" && record.session.key.length > 0
    && (record.status === "open" || record.status === "success" || record.status === "partial" || record.status === "failed" || record.status === "abandoned")
    && typeof record.summary === "string"
    && typeof record.startedAt === "string" && typeof record.updatedAt === "string"
    && Array.isArray(record.evidence) && Array.isArray(record.unresolvedRisks)
    && Boolean(record.facts && typeof record.facts === "object")
    && Array.isArray(record.facts.changedFiles)
    && Array.isArray(record.facts.validations)
    && Array.isArray(record.facts.failures);
}

export function normalizeEvaluationCases(raw: unknown): CloseoutEvaluationCase[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { cases?: unknown }).cases) ? (raw as { cases: unknown[] }).cases : [];
  return source.flatMap((item): CloseoutEvaluationCase[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (!isValidCloseout(entry.closeout) || !isValidObservation(entry.baseline, false) || !isValidObservation(entry.advisor, true)) return [];
    const id = clean(entry.id, 120);
    const taskClass = clean(entry.taskClass, MAX_TASK_CLASS);
    if (!id || !taskClass) return [];
    return [{
      id,
      taskClass,
      safetySensitive: entry.safetySensitive === true,
      closeout: entry.closeout,
      baseline: normalizeObservation(entry.baseline),
      advisor: normalizeAdvisor(entry.advisor),
    }];
  }).slice(0, MAX_CASES);
}

function successRate(rows: EvaluationObservation[]): number {
  return rows.length === 0 ? 0 : rows.filter((row) => row.result === "success").length / rows.length;
}

function average(rows: number[]): number {
  return rows.length === 0 ? 0 : rows.reduce((sum, value) => sum + value, 0) / rows.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildSlice(taskClass: string, cases: CloseoutEvaluationCase[]): EvaluationSlice {
  const calls = cases.filter((item) => item.advisor.ran);
  const evidenceRows = calls.filter((item) => item.advisor.evidenceBacked);
  const helpfulRows = calls.filter((item) => item.advisor.utility === "helpful");
  const baselineSuccessRate = successRate(calls.map((item) => item.baseline));
  const advisorSuccessRate = successRate(calls.map((item) => item.advisor));
  return {
    taskClass,
    samples: cases.length,
    baselineSuccessRate: round(baselineSuccessRate),
    advisorSuccessRate: round(advisorSuccessRate),
    successDelta: round(advisorSuccessRate - baselineSuccessRate),
    baselineAverageRework: round(average(calls.map((item) => item.baseline.reworkTurns))),
    advisorAverageRework: round(average(calls.map((item) => item.advisor.reworkTurns))),
    advisorCalls: calls.length,
    advisorHelpfulRate: round(calls.length ? helpfulRows.length / calls.length : 0),
    evidenceBackedRate: round(calls.length ? evidenceRows.length / calls.length : 0),
    safetyViolations: calls.filter((item) => item.safetySensitive && item.advisor.safety !== "fail_closed").length,
  };
}

export function evaluateCloseoutCases(cases: CloseoutEvaluationCase[]): CloseoutEvaluationReport {
  const normalized = normalizeEvaluationCases(cases);
  const calls = normalized.filter((item) => item.advisor.ran);
  const helpful = calls.filter((item) => item.advisor.utility === "helpful");
  const evidenceBacked = calls.filter((item) => item.advisor.evidenceBacked);
  const latencies = calls.map((item) => item.advisor.latencyMs).filter((value): value is number => value !== undefined);
  const classes = [...new Set(normalized.map((item) => item.taskClass))].sort();
  const slices = classes.map((taskClass) => buildSlice(taskClass, normalized.filter((item) => item.taskClass === taskClass)));
  const baselineSuccessRate = successRate(calls.map((item) => item.baseline));
  const advisorSuccessRate = successRate(calls.map((item) => item.advisor));
  return {
    version: CLOSEOUT_EVALUATION_VERSION,
    samples: normalized.length,
    pairedSamples: calls.length,
    baselineOnlySamples: normalized.length - calls.length,
    baselineSuccessRate: round(baselineSuccessRate),
    advisorSuccessRate: round(advisorSuccessRate),
    successDelta: round(advisorSuccessRate - baselineSuccessRate),
    baselineAverageRework: round(average(calls.map((item) => item.baseline.reworkTurns))),
    advisorAverageRework: round(average(calls.map((item) => item.advisor.reworkTurns))),
    advisorCalls: calls.length,
    advisorHelpfulRate: round(calls.length ? helpful.length / calls.length : 0),
    advisorEvidenceBackedRate: round(calls.length ? evidenceBacked.length / calls.length : 0),
    acceptedCalls: calls.filter((item) => item.advisor.disposition === "accepted").length,
    correctedCalls: calls.filter((item) => item.advisor.disposition === "corrected").length,
    dismissedCalls: calls.filter((item) => item.advisor.disposition === "dismissed").length,
    averageLatencyMs: latencies.length ? round(average(latencies)) : undefined,
    totalTokens: calls.reduce((sum, item) => sum + (item.advisor.tokens ?? 0), 0),
    totalCost: round(calls.reduce((sum, item) => sum + (item.advisor.cost ?? 0), 0)),
    safetyViolations: calls.filter((item) => item.safetySensitive && item.advisor.safety !== "fail_closed").length,
    slices,
  };
}

export function renderCloseoutEvaluationMarkdown(report: CloseoutEvaluationReport): string {
  const lines = [
    "# Explicit Advisor/Board closeout evaluation",
    "",
    "This is an offline descriptive report. It does not promote a model or policy.",
    "",
    "## Overall",
    "",
    `- Samples: ${report.samples}`,
    `- Paired baseline/Advisor samples: ${report.pairedSamples}`,
    `- Baseline-only samples: ${report.baselineOnlySamples}`,
    `- Baseline success rate (paired samples): ${report.baselineSuccessRate}`,
    `- Advisor/Board success rate: ${report.advisorSuccessRate}`,
    `- Success delta: ${report.successDelta}`,
    `- Baseline average rework turns: ${report.baselineAverageRework}`,
    `- Advisor/Board average rework turns: ${report.advisorAverageRework}`,
    `- Explicit Advisor/Board calls: ${report.advisorCalls}`,
    `- Helpful-call rate: ${report.advisorHelpfulRate}`,
    `- Evidence-backed-call rate: ${report.advisorEvidenceBackedRate}`,
    `- Accepted/corrected/dismissed: ${report.acceptedCalls}/${report.correctedCalls}/${report.dismissedCalls}`,
    `- Average latency (ms): ${report.averageLatencyMs ?? "not recorded"}`,
    `- Total tokens/cost: ${report.totalTokens}/${report.totalCost}`,
    `- Safety violations: ${report.safetyViolations}`,
    "",
    "## Slices",
    "",
    "| Task class | Samples | Baseline success | Advisor success | Delta | Baseline rework | Advisor rework | Calls | Helpful | Evidence-backed | Safety violations |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.slices.map((slice) => `| ${slice.taskClass} | ${slice.samples} | ${slice.baselineSuccessRate} | ${slice.advisorSuccessRate} | ${slice.successDelta} | ${slice.baselineAverageRework} | ${slice.advisorAverageRework} | ${slice.advisorCalls} | ${slice.advisorHelpfulRate} | ${slice.evidenceBackedRate} | ${slice.safetyViolations} |`),
    "",
    "## Recommendation",
    "",
    report.safetyViolations > 0 ? "**HOLD:** safety-sensitive cases violated the fail-closed expectation." : "**CONTINUE EVALUATION:** inspect per-slice samples and uncertainty before changing policy.",
    "",
  ];
  return lines.join("\n");
}
