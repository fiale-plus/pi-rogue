import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { advisorBoardWatchConfigPath, advisorModelInspectionText, inspectAdvisorModels, advisorSessionStatePath, normalizeAdvisorConfig, rankAvailableAdvisorModels, registerAdvisor, resolveModelCandidates, type AdvisorConfig } from "./extension.js";

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

describe("Advisor model choice inspection", () => {
  it("ranks role candidates with stable, role-specific policies", () => {
    const models = [
      { ...model("provider", "expensive"), name: "Expensive", reasoning: true, contextWindow: 128000, maxTokens: 16000, cost: { input: 10, output: 20 } },
      { ...model("provider", "cheap"), name: "Cheap", reasoning: false, contextWindow: 32000, maxTokens: 4000, cost: { input: 0.1, output: 0.2 } },
      { ...model("openai-codex", "gpt-5.5"), name: "Preferred", reasoning: true, contextWindow: 64000, maxTokens: 8000, cost: { input: 5, output: 10 } },
    ];
    expect(rankAvailableAdvisorModels("advisor", models).map((entry) => entry.id)).toEqual([
      "openai-codex/gpt-5.5", "provider/expensive", "provider/cheap",
    ]);
    expect(rankAvailableAdvisorModels("specialist", models).map((entry) => entry.id)).toEqual([
      "provider/cheap", "openai-codex/gpt-5.5", "provider/expensive",
    ]);
  });

  it("marks an unavailable explicit override and handles an empty catalog", () => {
    const config = normalizeAdvisorConfig({ models: { advisor: "missing/model" } });
    const inspection = inspectAdvisorModels(config, [model("provider", "available")]);
    expect(inspection[0]).toMatchObject({ configured: "missing/model", configuredAvailable: false, selected: "provider/available" });
    expect(advisorModelInspectionText(config, [])).toContain("No compatible authenticated text models found");
    expect(advisorModelInspectionText(config, [model("provider", "available")])).toContain("WARNING: configured model missing/model");
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

  it("fails over to an authenticated catalog model when an explicit path cannot authenticate", async () => {
    const explicit = model("provider-a", "chosen");
    const fallback = model("provider-b", "cheap");
    const attempted: string[] = [];
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === explicit.provider && id === explicit.id ? explicit : undefined,
        getAvailable: () => [fallback],
        getApiKeyAndHeaders: async (candidate: TestModel) => {
          attempted.push(`${candidate.provider}/${candidate.id}`);
          return candidate === explicit ? { ok: false, error: "not authenticated" } : { ok: true, apiKey: "key" };
        },
      },
    };
    const result = await resolveModelCandidates(ctx, normalizeAdvisorConfig({ models: { advisor: "provider-a/chosen" } }));
    expect(result.map((entry) => entry.label)).toEqual(["provider-b/cheap"]);
    expect(attempted).toEqual(["provider-a/chosen", "provider-b/cheap"]);
  });

  it("skips an unauthenticated static fallback for an authenticated catalog model", async () => {
    const explicit = model("provider-a", "chosen");
    const staticFallback = model("openai-codex", "gpt-5.5");
    const catalogFallback = model("provider-b", "cheap");
    const attempted: string[] = [];
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === explicit.provider && id === explicit.id ? explicit : provider === staticFallback.provider && id === staticFallback.id ? staticFallback : undefined,
        hasConfiguredAuth: (candidate: TestModel) => candidate !== staticFallback,
        getAvailable: () => [catalogFallback],
        getApiKeyAndHeaders: async (candidate: TestModel) => {
          attempted.push(`${candidate.provider}/${candidate.id}`);
          return { ok: true, apiKey: "key" };
        },
      },
    };
    const result = await resolveModelCandidates(ctx, normalizeAdvisorConfig({ models: { advisor: "provider-a/chosen" } }));
    expect(result.map((entry) => entry.label)).toEqual(["provider-a/chosen", "provider-b/cheap"]);
    expect(attempted).toEqual(["provider-a/chosen", "provider-b/cheap"]);
  });

  it("uses the same metadata ranking as inspection for an automatic specialist choice", async () => {
    const expensive = { ...model("provider", "expensive"), cost: { input: 10, output: 20 }, contextWindow: 128000 };
    const cheap = { ...model("provider", "cheap"), cost: { input: 0.1, output: 0.2 }, contextWindow: 32000 };
    const ctx = {
      modelRegistry: {
        find: () => undefined,
        getAvailable: () => [expensive, cheap],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
      },
    };
    const result = await resolveModelCandidates(ctx, normalizeAdvisorConfig({}), { role: "specialist" });
    expect(result.map((entry) => entry.label)).toEqual(["provider/cheap"]);
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
    expect(events).toEqual(["session_start", "turn_end", "agent_end", "agent_settled", "session_shutdown"]);
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
        { toolName: "read", input: { path: "packages/advisor/src/inspected.ts" }, status: "success" },
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
    expect(state.boardEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file_changed", path: "packages/advisor/src/inspected.ts" }),
    ]));
    expect(state.boardEvents.length).toBeLessThanOrEqual(64);
    expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
  });

  it("records changed files only for mutating tools", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAdvisor(pi);
    const ctx = { session: { id: `advisor-mutations-${Date.now()}-${Math.random()}` }, cwd: process.cwd(), ui: { setStatus: vi.fn() } };
    handlers.get("session_start")?.({}, ctx);
    handlers.get("turn_end")?.({
      turnIndex: 0,
      toolResults: [
        { toolName: "read", input: { path: "packages/advisor/README.md" }, status: "success" },
        { toolName: "search", input: { path: "packages/advisor/src" }, status: "success" },
        { toolName: "edit", input: { path: "packages/advisor/src/changed.ts" }, status: "success" },
      ],
    }, ctx);
    const state = JSON.parse(readFileSync(advisorSessionStatePath(ctx), "utf8"));
    expect(state.boardEvents.filter((event: unknown): event is { type: string; path: string } => (
      typeof event === "object" && event !== null &&
      "type" in event && event.type === "file_changed" &&
      "path" in event && typeof event.path === "string"
    )).map((event: { type: string; path: string }) => event.path)).toEqual([
      "packages/advisor/src/changed.ts",
    ]);
  });

  it("queues a non-binding next-turn message only when intervention mode is explicit", () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const sendMessage = vi.fn();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    writeFileSync(advisorBoardWatchConfigPath(), JSON.stringify({ mode: "intervene", cooldownTurns: 0, maxInterventions: 4 }));
    try {
      registerAdvisor(pi);
      const ctx = { session: { id: `advisor-watch-${Date.now()}-${Math.random()}` }, cwd: process.cwd(), ui: { setStatus: vi.fn() } };
      handlers.get("session_start")?.({}, ctx);
      handlers.get("turn_end")?.({ turnIndex: 0, toolResults: [{ toolName: "edit", input: { path: "packages/advisor/src/watched.ts" }, status: "success" }] }, ctx);
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "advisor:board", details: expect.objectContaining({ nonBinding: true, readOnly: true }) }), { triggerTurn: false, deliverAs: "nextTurn" });
      expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
    } finally {
      if (existsSync(advisorBoardWatchConfigPath())) unlinkSync(advisorBoardWatchConfigPath());
    }
  });

  it("escalates one material Board risk to a bounded read-only Head", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const sendMessage = vi.fn();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    vi.mocked(completeSimple).mockResolvedValue({ content: [{ type: "text", text: "Validate the changed file before proceeding." }] } as any);
    writeFileSync(advisorBoardWatchConfigPath(), JSON.stringify({ mode: "intervene", cooldownTurns: 0, maxInterventions: 4, headEscalation: "enabled", headMaxCalls: 1 }));
    try {
      registerAdvisor(pi);
      const ctx = {
        session: { id: `advisor-head-watch-${Date.now()}-${Math.random()}` },
        cwd: process.cwd(),
        ui: { setStatus: vi.fn() },
        modelRegistry: {
          find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id, input: ["text"] } : undefined,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
        },
      };
      handlers.get("session_start")?.({}, ctx);
      handlers.get("turn_end")?.({ turnIndex: 0, toolResults: [{ toolName: "edit", input: { path: "packages/advisor/src/head-watched.ts" }, status: "success" }] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "advisor:board", details: expect.objectContaining({ readOnly: true }) }), expect.objectContaining({ triggerTurn: false, deliverAs: "nextTurn" }));
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
      handlers.get("turn_end")?.({ turnIndex: 1, toolResults: [{ toolName: "edit", input: { path: "packages/advisor/src/another-head-watched.ts" }, status: "success" }] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
    } finally {
      if (existsSync(advisorBoardWatchConfigPath())) unlinkSync(advisorBoardWatchConfigPath());
    }
  });

  it("can escalate a shadow risk to Head without enabling Board intervention", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const sendMessage = vi.fn();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    const callsBefore = vi.mocked(completeSimple).mock.calls.length;
    vi.mocked(completeSimple).mockResolvedValue({ content: [{ type: "text", text: "Validate before continuing." }] } as any);
    writeFileSync(advisorBoardWatchConfigPath(), JSON.stringify({ mode: "shadow", maxInterventions: 0, headEscalation: "enabled", headMaxCalls: 1 }));
    try {
      registerAdvisor(pi);
      const ctx = {
        session: { id: `advisor-shadow-head-${Date.now()}-${Math.random()}` },
        cwd: process.cwd(),
        ui: { setStatus: vi.fn() },
        modelRegistry: {
          find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id, input: ["text"] } : undefined,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
        },
      };
      handlers.get("turn_end")?.({ turnIndex: 0, toolResults: [{ toolName: "edit", input: { path: "packages/advisor/src/shadow-head.ts" }, status: "success" }] }, ctx);
      handlers.get("turn_end")?.({ turnIndex: 1, toolResults: [{ toolName: "edit", input: { path: "packages/advisor/src/shadow-head-2.ts" }, status: "success" }] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(callsBefore + 1);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      if (existsSync(advisorBoardWatchConfigPath())) unlinkSync(advisorBoardWatchConfigPath());
    }
  });

  it("deduplicates repeated lifecycle events while preserving same-turn failures", () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(event, handler); },
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAdvisor(pi);
    const ctx = { session: { id: `advisor-dedupe-${Date.now()}-${Math.random()}` }, cwd: process.cwd(), ui: { setStatus: vi.fn() } };
    const failure = { toolName: "bash", input: { command: "npm test" }, status: "error", error: "failure" };
    const event = { turnIndex: 0, toolResults: [failure, failure, failure] };
    handlers.get("turn_end")?.(event, ctx);
    handlers.get("agent_end")?.(event, ctx);
    const state = JSON.parse(readFileSync(advisorSessionStatePath(ctx), "utf8"));
    expect(state.boardEvents.filter((item: any) => item.type === "tool_failure")).toHaveLength(3);
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
