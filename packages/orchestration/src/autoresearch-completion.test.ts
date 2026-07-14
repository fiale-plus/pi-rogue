import { describe, expect, it } from "vitest";
import { hasResearchCompletionEvidence, researchCompletionBlock } from "./autoresearch-completion.js";

describe("autoresearch completion policy", () => {
  it("requires two cycles before accepting done", () => {
    expect(researchCompletionBlock({ cycles: 1, evidenceCycles: 1 }, "done", "npm test passed 20 tests")).toMatch(/at least 2 distinct cycles/);
  });

  it("requires research-specific evidence with a result", () => {
    expect(researchCompletionBlock({ cycles: 2, evidenceCycles: 2 }, "done", "looks complete from inspection")).toMatch(/explicit check, evaluation, benchmark, or metric evidence/);
    for (const claim of [
      "we should run npm test later",
      "evaluation result is pending",
      "test result will be recorded later",
      "validation result unavailable",
      "benchmark failed to run",
      "Not verified: tests were not run.",
      "npm test has not been run but should pass",
      "baseline 70%, target 80%",
      "npm test likely passes",
      "pytest hasn't been run but should pass",
      "evaluation score is unknown",
      "benchmark score TBD",
    ]) expect(hasResearchCompletionEvidence(claim), claim).toBe(false);
  });

  it("accepts check and metric results", () => {
    expect(researchCompletionBlock({ cycles: 2, evidenceCycles: 2 }, "done", "npm run check passed; 42 tests passed")).toBeNull();
    expect(hasResearchCompletionEvidence("accuracy metric improved from 70% to 83%")).toBe(true);
    expect(hasResearchCompletionEvidence("benchmark unavailable; npm test passed 42 tests")).toBe(true);
    expect(hasResearchCompletionEvidence("pytest -q: 42 passed in 1.2s")).toBe(true);
    expect(hasResearchCompletionEvidence("go test ./...: ok")).toBe(true);
    expect(hasResearchCompletionEvidence("all tests passed")).toBe(true);
    expect(hasResearchCompletionEvidence("all checks passed")).toBe(true);
    expect(hasResearchCompletionEvidence("Ran focused unit tests successfully.")).toBe(true);
    expect(hasResearchCompletionEvidence("benchmark unavailable but npm test passed 42 tests")).toBe(true);
    expect(hasResearchCompletionEvidence("npm test: 42 passing (250ms)")).toBe(true);
    expect(hasResearchCompletionEvidence("npm run check\nexit 0")).toBe(true);
    expect(hasResearchCompletionEvidence("go test ./...\nok")).toBe(true);
  });
});
