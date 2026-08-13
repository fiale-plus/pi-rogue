import { describe, expect, it } from "vitest";
import {
  evaluateHarmonizationGate,
  HARMONIZATION_GATE_FIXTURES,
  serializeHarmonizationGateReport,
} from "../../../scripts/harmonization-gate-eval.js";

describe("harmonization gate evaluation", () => {
  it("reports deterministic phase, task, and safety metrics without promotion claims", () => {
    const report = evaluateHarmonizationGate(HARMONIZATION_GATE_FIXTURES);
    expect(report.schema).toBe("pi-rogue.harmonization-gate-eval.v1");
    expect(report.rows).toBe(7);
    expect(report.phases.review.gateAdvisorCalls).toBe(2);
    expect(report.taskClasses.safety_sensitive.missedEscalations).toBe(0);
    expect(report.failure.failureRows).toBe(1);
    expect(report.recommendation).toBe("hold");
    expect(serializeHarmonizationGateReport(report)).toBe(serializeHarmonizationGateReport(evaluateHarmonizationGate([...HARMONIZATION_GATE_FIXTURES].reverse())));
  });

  it("rejects a real replay with a missed safety escalation", () => {
    const report = evaluateHarmonizationGate([{ ...HARMONIZATION_GATE_FIXTURES[5], gateDecision: "continue" }], "real_replay");
    expect(report.recommendation).toBe("reject");
    expect(report.safety.missedEscalations).toBe(1);
  });

  it("rejects unknown or raw fields instead of accepting them", () => {
    expect(() => evaluateHarmonizationGate([{ ...HARMONIZATION_GATE_FIXTURES[0], prompt: "raw" } as never])).toThrow(/unknown or missing fields/);
    expect(() => evaluateHarmonizationGate([HARMONIZATION_GATE_FIXTURES[0], HARMONIZATION_GATE_FIXTURES[0]])).toThrow(/duplicate row.id/);
  });

  it("rejects prototype-collision failure classes", () => {
    expect(() => evaluateHarmonizationGate([{ ...HARMONIZATION_GATE_FIXTURES[0], failureClass: "toString" } as never])).toThrow(/failureClass is invalid/);
  });

  it("holds real replay without both decision labels", () => {
    const rows = Array.from({ length: 32 }, (_, index) => ({
      ...HARMONIZATION_GATE_FIXTURES[index % HARMONIZATION_GATE_FIXTURES.length],
      id: `replay-${index}`,
      phase: (["preflight", "review", "closeout"] as const)[index % 3],
      taskClass: (["quick_edit", "implementation", "debug", "review", "architecture", "safety_sensitive", "trivial", "failure"] as const)[index % 8],
      label: "continue" as const,
      baselineDecision: "continue" as const,
      gateDecision: "continue" as const,
      baselineOutcome: "accepted" as const,
      gateOutcome: "accepted" as const,
      failureClass: index === 0 ? "timeout" as const : "none" as const,
    }));
    const report = evaluateHarmonizationGate(rows, "real_replay");
    expect(report.recommendation).toBe("hold");
    expect(report.recommendationReason).toContain("both decision labels");
  });

  it("holds real replay with incomplete outcomes", () => {
    const rows = Array.from({ length: 32 }, (_, index) => ({
      ...HARMONIZATION_GATE_FIXTURES[index % HARMONIZATION_GATE_FIXTURES.length],
      id: `incomplete-${index}`,
      phase: (["preflight", "review", "closeout"] as const)[index % 3],
      taskClass: (["quick_edit", "implementation", "debug", "review", "architecture", "safety_sensitive", "trivial", "failure"] as const)[index % 8],
      label: index % 2 === 0 ? "continue" as const : "escalate" as const,
      baselineDecision: index % 2 === 0 ? "continue" as const : "escalate" as const,
      gateDecision: index % 2 === 0 ? "continue" as const : "escalate" as const,
      baselineOutcome: "incomplete" as const,
      gateOutcome: "incomplete" as const,
      failureClass: index === 0 ? "timeout" as const : "none" as const,
    }));
    const report = evaluateHarmonizationGate(rows, "real_replay");
    expect(report.recommendation).toBe("hold");
    expect(report.recommendationReason).toContain("known complete outcomes");
  });
});
