import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { advisorSessionStatePath, normalizeAdvisorConfig, registerAdvisor, resolveModelCandidates, type AdvisorConfig } from "./extension.js";

vi.mock("@earendil-works/pi-ai/compat", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
  return { ...actual, completeSimple: vi.fn() };
});

type TestModel = { provider: string; id: string; input: string[] };

function model(provider: string, id: string): TestModel {
  return { provider, id, input: ["text"] };
}

describe("Advisor PR1 configuration", () => {
  it("normalizes the exact explicit Board configuration shape", () => {
    const config = normalizeAdvisorConfig({
      model: "anthropic/claude-sonnet-4-6",
      board: { specialists: "off", maxSpecialistCalls: 99, specialistMaxTokens: 99, headMaxTokens: 99999 },
      mode: "auto",
      review: "strict",
      profile: "budget-board",
    });
    expect(config).toEqual({
      models: { advisor: "anthropic/claude-sonnet-4-6" },
      board: { specialists: "off", maxSpecialistCalls: 8, specialistMaxTokens: 100, headMaxTokens: 1200 },
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
  it("registers data-only lifecycle collectors without model work", () => {
    const events: string[] = [];
    const pi = {
      on: (event: string) => { events.push(event); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAdvisor(pi);
    expect(events).toEqual(["session_start", "turn_end", "agent_end", "session_shutdown"]);
    expect(events).not.toContain("before_agent_start");
    expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
  });

  it("collects fresh-session changed-file and failure evidence without prompt or model work", () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAdvisor(pi);
    const ctx = { session: { id: `advisor-evidence-${Date.now()}-${Math.random()}` }, cwd: process.cwd(), ui: { setStatus: vi.fn() } };
    handlers.get("session_start")?.({}, ctx);
    handlers.get("turn_end")?.({
      turnIndex: 0,
      toolResults: [
        { toolName: "edit", input: { path: "packages/advisor/src/changed.ts" }, status: "success" },
        { toolName: "bash", input: { command: "npm test" }, status: "error", error: "failure with SECRET=do-not-persist" },
      ],
    }, ctx);
    const state = JSON.parse(readFileSync(advisorSessionStatePath(ctx), "utf8"));
    expect(state.turns).toBe(1);
    expect(state.boardEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file_changed", path: "packages/advisor/src/changed.ts", turn: 1 }),
      expect.objectContaining({ type: "tool_failure", tool: "bash", message: expect.not.stringContaining("SECRET=do-not-persist"), turn: 1 }),
    ]));
    expect(state.boardEvents.length).toBeLessThanOrEqual(64);
    expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
  });

  it("increments turns on turn_end only, keeping cooldown turn accounting stable", () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAdvisor(pi);
    const ctx = { session: { id: `advisor-turns-${Date.now()}-${Math.random()}` }, cwd: process.cwd(), ui: { setStatus: vi.fn() } };
    handlers.get("session_start")?.({}, ctx);
    handlers.get("turn_end")?.({ turnIndex: 2, toolResults: [] }, ctx);
    handlers.get("agent_end")?.({ turnIndex: 2, toolResults: [] }, ctx);
    handlers.get("agent_end")?.({ turnIndex: 2, toolResults: [] }, ctx);
    handlers.get("turn_end")?.({ turnIndex: 3, toolResults: [] }, ctx);
    const state = JSON.parse(readFileSync(advisorSessionStatePath(ctx), "utf8"));
    expect(state.turns).toBe(4);
  });
});

void ({} satisfies Partial<AdvisorConfig>);
