import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { normalizeAdvisorConfig, registerAdvisor, resolveModelCandidates, type AdvisorConfig } from "./extension.js";

vi.mock("@earendil-works/pi-ai/compat", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
  return { ...actual, completeSimple: vi.fn() };
});

type TestModel = { provider: string; id: string; input: string[] };

function model(provider: string, id: string): TestModel {
  return { provider, id, input: ["text"] };
}

describe("Advisor PR1 configuration", () => {
  it("normalizes to explicit model slots and bounded Board settings", () => {
    const config = normalizeAdvisorConfig({
      model: "anthropic/claude-sonnet-4-6",
      board: { maxEvidence: 99, maxRisks: 0, maxFailures: 99, maxSubagents: -1, maxTokens: 99999 },
      mode: "auto",
      review: "strict",
      checkins: "mid-hour",
      profile: "budget-board",
    });
    expect(config).toEqual({
      models: { advisor: "anthropic/claude-sonnet-4-6" },
      board: { maxEvidence: 32, maxRisks: 1, maxFailures: 12, maxSubagents: 1, maxTokens: 2400 },
    });
    expect("mode" in config).toBe(false);
    expect("review" in config).toBe(false);
    expect("profile" in config).toBe(false);
  });

  it("normalizes separate advisor, specialist, and head slots", () => {
    const config = normalizeAdvisorConfig({
      models: { advisor: "openai-codex/gpt-5.5", specialist: "anthropic/claude-sonnet-4-6", head: "anthropic/claude-opus-4-6" },
    });
    expect(config.models).toEqual({
      advisor: "openai-codex/gpt-5.5",
      specialist: "anthropic/claude-sonnet-4-6",
      head: "anthropic/claude-opus-4-6",
    });
  });
});

describe("Advisor PR1 bounded model resolution", () => {
  it("uses an explicit model and at most one preferred fallback", async () => {
    const explicit = model("provider-a", "chosen");
    const preferred = model("openai-codex", "gpt-5.5");
    const attempted: string[] = [];
    const getAvailable = vi.fn(() => {
      throw new Error("available-model enumeration is forbidden");
    });
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === explicit.provider && id === explicit.id ? explicit : provider === preferred.provider && id === preferred.id ? preferred : undefined,
        getAvailable,
        getApiKeyAndHeaders: async (candidate: TestModel) => {
          attempted.push(`${candidate.provider}/${candidate.id}`);
          return { ok: true, apiKey: `${candidate.id}-key` };
        },
      },
    };
    const result = await resolveModelCandidates(ctx, normalizeAdvisorConfig({ models: { advisor: "provider-a/chosen" } }));
    expect(result.map((entry) => entry.model)).toEqual([explicit, preferred]);
    expect(attempted).toEqual(["provider-a/chosen", "openai-codex/gpt-5.5"]);
    expect(getAvailable).not.toHaveBeenCalled();
  });

  it("uses exactly one preferred candidate when no explicit model is configured", async () => {
    const preferred = model("openai-codex", "gpt-5.5");
    const attempted: string[] = [];
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === preferred.provider && id === preferred.id ? preferred : undefined,
        getAvailable: vi.fn(() => [model("other", "unrelated")]),
        getApiKeyAndHeaders: async (candidate: TestModel) => {
          attempted.push(`${candidate.provider}/${candidate.id}`);
          return { ok: true, apiKey: "key" };
        },
      },
    };
    await resolveModelCandidates(ctx, normalizeAdvisorConfig({}));
    expect(attempted).toEqual(["openai-codex/gpt-5.5"]);
  });
});

describe("Advisor PR1 lifecycle", () => {
  it("registers no automatic model-work lifecycle handlers", () => {
    const events: string[] = [];
    const pi = {
      on: (event: string) => { events.push(event); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAdvisor(pi);
    expect(events).toEqual(["session_start", "session_shutdown"]);
    expect(events).not.toContain("before_agent_start");
    expect(events).not.toContain("turn_end");
    expect(events).not.toContain("agent_end");
    expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
  });
});

void ({} satisfies Partial<AdvisorConfig>);
