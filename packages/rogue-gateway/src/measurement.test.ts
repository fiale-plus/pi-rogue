import { describe, expect, it } from "vitest";

import { measurePiDedicatedModes } from "./measurement.js";
import type { PiRogueRouterConfig } from "./model-routing.js";
import { SubstrateMock } from "./substrate-mock.js";

const fixtureRouterConfig: PiRogueRouterConfig = {
  activeProfile: "local-smart",
  profiles: {
    "local-smart": {
      smart: "openai-codex/gpt-5.5",
      worker: "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-q4-k-m",
      reviewer: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      explore: "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-q4-k-m",
      debug_diagnose: "openai-codex/gpt-5.5",
      review: "openai-codex/gpt-5.5",
      verify: "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-q4-k-m",
    },
  },
};

describe("pi-dedicated mode measurements", () => {
  it("maps the pi-dedicated request to a configured GPT upstream target and reports mode token deltas", async () => {
    const report = await measurePiDedicatedModes({
      routerConfig: fixtureRouterConfig,
      profile: "local-smart",
      role: "smart",
      substrate: new SubstrateMock("substrate-mock", {
        models: [{ id: "openai-codex/gpt-5.5", object: "model" }],
      }),
      request: {
        profile: "local-first-economy",
        taskKind: "coding_debug",
        rawInputTokensApprox: 82_000,
        forwardedInputTokensApprox: 2_400,
        expectedOutputTokensApprox: 900,
        contextPolicy: "typed_lens",
        candidateAssets: ["local.qwen35", "remote.cheap", "remote.premium", "subscription.smart"],
      },
    });

    expect(report.requestedModel).toBe("pi-dedicated");
    expect(report.upstreamModel).toBe("openai-codex/gpt-5.5");
    expect(report.modes.map((mode) => mode.mode)).toEqual([
      "raw_forward",
      "typed_lens",
      "lookup_compress",
    ]);

    const rawForward = report.modes[0];
    const typedLens = report.modes[1];
    const lookupCompress = report.modes[2];

    expect(rawForward.request.forwardedInputTokensApprox).toBe(82_000);
    expect(typedLens.request.forwardedInputTokensApprox).toBe(2_400);
    expect(lookupCompress.request.forwardedInputTokensApprox).toBeLessThan(typedLens.request.forwardedInputTokensApprox ?? 0);
    expect(rawForward.quote.selected.asset).toBeDefined();
    expect(rawForward.quote.selected.route).toMatch(/^(local_first_typed_lens|cheap_remote_typed_lens|subscription_hard_call|premium_sealed_packet|premium_raw_oracle_eval_only)$/);
    expect(rawForward.chat.usage?.total_tokens).toBeGreaterThan(typedLens.chat.usage?.total_tokens ?? 0);
    expect(typedLens.chat.usage?.total_tokens).toBeLessThan(lookupCompress.chat.usage?.total_tokens ?? 0);
  });
});
