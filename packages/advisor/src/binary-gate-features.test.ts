import { describe, expect, it } from "vitest";
import { extractBinaryGateFeatureCounts } from "./binary-gate-features.js";

describe("binary gate feature extraction", () => {
  it("emits shared lexical and routing cue features", () => {
    const features = extractBinaryGateFeatureCounts("review the auth migration diff before production deploy?");

    expect(features.get("cue:question_mark")).toBe(1);
    expect(features.get("cue:question_punct")).toBe(1);
    expect(features.get("cue:imperative")).toBe(1);
    expect(features.get("len_bucket:medium")).toBe(1);
    expect(features.get("complex:auth")).toBe(1);
    expect(features.get("complex:migration")).toBe(1);
    expect(features.get("review:review")).toBe(1);
    expect(features.get("review:diff")).toBe(1);
    expect(features.get("safety:production")).toBe(1);
    expect(features.get("safety:deploy")).toBe(1);
  });

  it("emits stuck/no-progress cues for the binary gate", () => {
    const features = extractBinaryGateFeatureCounts("goal loop stuck with repeated planning and no concrete progress");

    expect(features.get("stuck:stuck")).toBe(1);
    expect(features.get("stuck:repeated_planning")).toBe(1);
    expect(features.get("stuck:no_concrete_progress")).toBe(1);
  });
});
