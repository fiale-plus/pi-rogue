import { describe, expect, it } from "vitest";
import { evaluateCloseoutCases, normalizeEvaluationCases, renderCloseoutEvaluationMarkdown, type CloseoutEvaluationCase } from "./closeout-eval.js";

const closeout = {
  version: 1 as const,
  session: { key: "v2-session" },
  status: "success" as const,
  summary: "bounded closeout",
  startedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  evidence: [{ kind: "handle" as const, reference: "ctx://validation", addedAt: "2026-01-01T00:00:01Z" }],
  unresolvedRisks: [],
  facts: { turns: 3, changedFiles: ["src/fixed.ts"], validations: [], failures: [], advisorCalls: 1, specialistCalls: 0, headCalls: 0 },
};

function evaluationCase(overrides: Partial<CloseoutEvaluationCase> = {}): CloseoutEvaluationCase {
  return {
    id: "case-1",
    taskClass: "implementation",
    safetySensitive: false,
    closeout,
    baseline: { result: "partial", reworkTurns: 3, validationPasses: 1, validationFailures: 1 },
    advisor: { result: "success", reworkTurns: 1, validationPasses: 2, validationFailures: 0, ran: true, utility: "helpful", disposition: "accepted", evidenceBacked: true, safety: "approved", latencyMs: 100, tokens: 40, cost: 0.2 },
    ...overrides,
  };
}

describe("closeout evaluation", () => {
  it("consumes closeout records and reports overall plus task-class slices", () => {
    const report = evaluateCloseoutCases([
      evaluationCase(),
      evaluationCase({ id: "case-2", taskClass: "debug", advisor: { ...evaluationCase().advisor, utility: "neutral", disposition: "corrected", ran: true, evidenceBacked: false } }),
      evaluationCase({ id: "case-3", taskClass: "safety", safetySensitive: true, advisor: { ...evaluationCase().advisor, ran: false, utility: "not_run", safety: "fail_closed" } }),
    ]);

    expect(report.samples).toBe(3);
    expect(report.advisorCalls).toBe(2);
    expect(report.advisorHelpfulRate).toBe(0.5);
    expect(report.advisorEvidenceBackedRate).toBe(0.5);
    expect(report.acceptedCalls).toBe(1);
    expect(report.correctedCalls).toBe(1);
    expect(report.safetyViolations).toBe(0);
    expect(report.slices.map((slice) => slice.taskClass)).toEqual(["debug", "implementation", "safety"]);
  });

  it("fails closed in the report for safety-sensitive calls that do not declare fail-closed handling", () => {
    const report = evaluateCloseoutCases([evaluationCase({ safetySensitive: true, advisor: { ...evaluationCase().advisor, safety: "unknown" } })]);
    expect(report.safetyViolations).toBe(1);
    expect(renderCloseoutEvaluationMarkdown(report)).toContain("**HOLD:**");
  });

  it("drops malformed cases and never emits raw closeout payloads", () => {
    const cases = normalizeEvaluationCases({
      cases: [
        evaluationCase(),
        { id: "bad", taskClass: "", closeout: { version: 1, session: { key: "x" } } },
        { id: "bad-closeout", taskClass: "review", closeout: { version: 2, session: { key: "x" } } },
      ],
      rawTranscript: "SECRET raw transcript",
    });
    expect(cases).toHaveLength(1);
    const report = evaluateCloseoutCases(cases);
    expect(renderCloseoutEvaluationMarkdown(report)).not.toContain("SECRET raw transcript");
  });
});
