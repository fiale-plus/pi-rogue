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
    expect(report.rows).toBe(6);
    expect(report.phases.review.gateAdvisorCalls).toBe(1);
    expect(report.taskClasses.safety_sensitive.missedEscalations).toBe(0);
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
});
