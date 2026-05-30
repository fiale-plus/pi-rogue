import { beforeEach, describe, expect, it } from "vitest";
import { hasResearchCompletionEvidence, shouldHoldResearchOpen } from "./autoresearch-completion.js";

describe("autoresearch completion guard", () => {
  beforeEach(() => {
    delete process.env.PI_ROGUE_AUTORESEARCH_MIN_CYCLES;
  });

  it("holds autoresearch open when the first cycle claims GOAL_DONE", () => {
    const reason = shouldHoldResearchOpen(
      { cycles: 1 },
      "done",
      "GOAL_DONE: wired command through goal and loop",
    );

    expect(reason).toMatch(/at least 2 cycles/);
  });

  it("requires explicit check or evaluation evidence before completion", () => {
    const reason = shouldHoldResearchOpen(
      { cycles: 2 },
      "done",
      "GOAL_DONE: looks complete from inspection",
    );

    expect(reason).toMatch(/check\/evaluation\/metric evidence/);
  });

  it("allows completion after enough cycles with validation evidence", () => {
    const reason = shouldHoldResearchOpen(
      { cycles: 2 },
      "done",
      "GOAL_DONE: released after npm run check, npm test, and npm pack validation",
    );

    expect(reason).toBeNull();
  });

  it("is configurable via PI_ROGUE_AUTORESEARCH_MIN_CYCLES", () => {
    process.env.PI_ROGUE_AUTORESEARCH_MIN_CYCLES = "3";

    const tooSoon = shouldHoldResearchOpen(
      { cycles: 2 },
      "done",
      "GOAL_DONE: released after npm run check and npm test",
    );

    expect(tooSoon).toMatch(/at least 3 cycles/);

    const enough = shouldHoldResearchOpen(
      { cycles: 3 },
      "done",
      "GOAL_DONE: released after npm run check and npm test",
    );

    expect(enough).toBeNull();
  });

  it("recognizes validation evidence terms", () => {
    expect(hasResearchCompletionEvidence("npm run check and npm test passed")).toBe(true);
    expect(hasResearchCompletionEvidence("metric improved from 0.70 to 0.83")).toBe(true);
    expect(hasResearchCompletionEvidence("looks fine")).toBe(false);
  });
});
