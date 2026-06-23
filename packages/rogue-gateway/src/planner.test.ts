import { describe, expect, it } from "vitest";

import { quoteRoute } from "./planner.js";
import { defaultAssetRegistry } from "./default-assets.js";
import type { QuoteRequest } from "./types.js";

describe("rogue gateway route planning", () => {
  const baseRequest = (overrides: Partial<QuoteRequest> = {}): QuoteRequest => ({
    profile: "local-first-economy",
    taskKind: "coding_debug",
    rawInputTokensApprox: 82_000,
    forwardedInputTokensApprox: 2_400,
    expectedOutputTokensApprox: 900,
    contextPolicy: "typed_lens",
    candidateAssets: ["local.qwen35", "remote.cheap", "remote.premium", "subscription.smart"],
    repeatedFailureHint: 0,
    evalOnly: false,
    ...overrides,
  });

  it("prefers local-first route when profile is local-first-economy", () => {
    const result = quoteRoute({
      request: baseRequest(),
      registry: defaultAssetRegistry,
    });

    expect(result.selected.route).toBe("local_first_typed_lens");
    expect(result.selected.asset).toBe("local.qwen35");
    expect(result.alternatives.length).toBeGreaterThanOrEqual(3);
    expect(result.selected.estimatedTotalTokenCostUsd).toBe(0);
  });

  it("blocks premium raw oracle unless evalOnly is enabled", () => {
    const request = baseRequest({ profile: "fast-but-not-crazy" });
    const result = quoteRoute({
      request,
      registry: defaultAssetRegistry,
    });

    const premiumRaw = result.alternatives.find((alternative) => alternative.route === "premium_raw_oracle_eval_only");

    expect(premiumRaw).toBeDefined();
    expect(premiumRaw?.reasonNotChosen).toContain("evalOnly");
    expect(result.guards.rawFullContextToPremium).toBe(true);
  });

  it("unblocks premium raw oracle when evalOnly=true", () => {
    const request = baseRequest({ profile: "fast-but-not-crazy", evalOnly: true });
    const result = quoteRoute({
      request,
      registry: defaultAssetRegistry,
    });

    const premiumRaw = result.alternatives.find((alternative) => alternative.route === "premium_raw_oracle_eval_only");
    expect(premiumRaw).toBeDefined();
    expect(premiumRaw?.reasonNotChosen).toContain("score worse");
    expect(result.selected.route).not.toBe("premium_raw_oracle_eval_only");
  });
});
