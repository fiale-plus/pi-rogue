import { describe, expect, it } from "vitest";
import { evaluateSourceHoldout, splitThresholdValidation, type Config, type Example } from "../../../scripts/eval-binary-gate-sources.js";

const config: Config = { maxFeatures: 200, minDf: 1, epochs: 4, fnCost: 3, fpCost: 1, thresholdSteps: 21 };

function rows(label: "continue" | "escalate", count: number, source = "train"): Example[] {
  return Array.from({ length: count }, (_, index) => ({
    label,
    source,
    text: label === "continue" ? `routine implementation ${index}` : `security failure investigate ${index}`,
  }));
}

describe("source holdout evaluation", () => {
  it("keeps threshold and majority label independent of held-out labels", () => {
    const train = [...rows("continue", 12), ...rows("escalate", 8)];
    const heldOut = [...rows("continue", 3, "held"), ...rows("escalate", 1, "held")];
    const flipped = heldOut.map((row) => ({ ...row, label: row.label === "continue" ? "escalate" as const : "continue" as const }));

    const first = evaluateSourceHoldout(train, heldOut, config, "held");
    const second = evaluateSourceHoldout(train, flipped, config, "held");

    expect(second.threshold).toBe(first.threshold);
    expect(second.majority.label).toBe(first.majority.label);
    expect(first.majority).toEqual({ label: "continue", accuracy: 0.75 });
    expect(second.majority.accuracy).toBe(0.25);
  });

  it("uses deterministic, order-independent splitting and evaluation", () => {
    const train = [...rows("continue", 10), ...rows("escalate", 5)];
    const held = [...rows("continue", 2, "held"), ...rows("escalate", 2, "held")];
    const forward = splitThresholdValidation(train);
    const reversed = splitThresholdValidation([...train].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.validation.filter((row) => row.label === "continue")).toHaveLength(2);
    expect(forward.validation.filter((row) => row.label === "escalate")).toHaveLength(1);
    expect(evaluateSourceHoldout([...train].reverse(), [...held].reverse(), config, "held"))
      .toEqual(evaluateSourceHoldout(train, held, config, "held"));
  });

  it("keeps non-ASCII validation membership independent of input ordering", () => {
    const train: Example[] = ["ä", "a", "z", "b"].flatMap((text) => ([
      { text, label: "continue" as const, source: "train" },
      { text, label: "escalate" as const, source: "train" },
    ]));

    expect(splitThresholdValidation([...train].reverse())).toEqual(splitThresholdValidation(train));
    expect(splitThresholdValidation(train).validation.map((row) => row.text)).toEqual(["a", "a"]);
  });

  it.each([
    [1, 1],
    [19, 1],
    [1, 19],
    [5, 0],
  ])("falls back to a fixed threshold for unsupported validation (%i/%i)", (continueCount, escalateCount) => {
    const train = [...rows("continue", continueCount), ...rows("escalate", escalateCount)];
    const result = evaluateSourceHoldout(train, rows("continue", 2, "held"), config, "held");

    expect(result.threshold).toBe(0.5);
    expect(result.thresholdSelection.source).toBe("fixed-fallback");
  });
});
