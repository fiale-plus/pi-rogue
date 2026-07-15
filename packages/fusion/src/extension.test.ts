import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai/compat", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
  return {
    ...actual,
    completeSimple: completeSimpleMock,
  };
});

import { registerFusion } from "./extension.js";

function createPiMock() {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const providers = new Map<string, any>();
  const unregistered: string[] = [];
  const pi: any = {
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerProvider(name: string, provider: any) {
      providers.set(name, provider);
    },
    unregisterProvider(name: string) {
      unregistered.push(name);
      providers.delete(name);
    },
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  return { pi, commands, handlers, providers, unregistered };
}

function createCtx(cwd: string, notifications: Array<{ message: string; type?: string }> = []) {
  return {
    cwd,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    modelRegistry: {
      getAvailable() {
        return [
          { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
          { provider: "openai-codex", id: "gpt-5.3-codex-spark", input: ["text"] },
          { provider: "image-only", id: "paint", input: ["image"] },
          { provider: "fusion", id: "existing", input: ["text"] },
        ];
      },
      find(provider: string, id: string) {
        return { provider, id, input: ["text"], api: "mock-api" };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "mock-key", headers: {} };
      },
    },
  };
}

describe("fusion extension", () => {
  const oldRecipes = process.env.PI_ROGUE_FUSION_RECIPES;
  const oldTraceDir = process.env.PI_ROGUE_FUSION_TRACE_DIR;
  const oldHome = process.env.HOME;
  let isolatedHome = "";

  beforeEach(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), "fusion-home-"));
    process.env.HOME = isolatedHome;
    delete process.env.PI_ROGUE_FUSION_RECIPES;
    delete process.env.PI_ROGUE_FUSION_TRACE_DIR;
  });

  afterEach(() => {
    if (oldRecipes === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES;
    else process.env.PI_ROGUE_FUSION_RECIPES = oldRecipes;
    if (oldTraceDir === undefined) delete process.env.PI_ROGUE_FUSION_TRACE_DIR;
    else process.env.PI_ROGUE_FUSION_TRACE_DIR = oldTraceDir;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    isolatedHome = "";
  });

  it("registers the /pi-rogue-fusion command by default but no provider when no recipes exist", () => {
    delete process.env.PI_ROGUE_FUSION_RECIPES;
    const cwd = mkdtempSync(join(tmpdir(), "fusion-no-recipes-"));
    try {
      const { pi, commands, handlers, providers, unregistered } = createPiMock();
      registerFusion(pi);
      expect(commands.has("pi-rogue-fusion")).toBe(true);
      handlers.get("session_start")?.[0]?.({}, createCtx(cwd));
      expect(providers.has("fusion")).toBe(false);
      expect(unregistered).toContain("fusion");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("auto-registers fusion models when recipes exist without requiring an enable env var", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-recipes-"));
    const target = join(cwd, "test-recipes.json");
    const prevEnv = process.env.PI_ROGUE_FUSION_RECIPES;
    try {
      writeFileSync(target, JSON.stringify({ recipes: [{
        schema: "pi-rogue.fusion.recipe.v1",
        kind: "fusion",
        id: "hard-judge",
        model: "openai-codex/gpt-5.5",
        analysis_models: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.3-codex-spark"],
      }] }, null, 2));
      process.env.PI_ROGUE_FUSION_RECIPES = target;

      const { pi, handlers, providers } = createPiMock();
      registerFusion(pi);
      handlers.get("session_start")?.[0]?.({}, createCtx(cwd));

      expect(providers.has("fusion")).toBe(true);
      const ids = providers.get("fusion").models.map((model: any) => model.id);
      expect(ids).toContain("hard-judge");
    } finally {
      if (prevEnv === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES; else process.env.PI_ROGUE_FUSION_RECIPES = prevEnv;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("/pi-rogue-fusion configure adds a recipe and guides reload/pi-rogue-router next steps", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-configure-"));
    const notifications: Array<{ message: string; type?: string }> = [];
    const targetRecipe = join(cwd, ".pi-rogue", "fusion", "recipes.json");
    const prev = process.env.PI_ROGUE_FUSION_RECIPES;
    try {
      process.env.PI_ROGUE_FUSION_RECIPES = targetRecipe;
      const { pi, commands } = createPiMock();
      registerFusion(pi);
      const fusion = commands.get("pi-rogue-fusion");
      await fusion.handler(
        "configure add hard-judge openai-codex/gpt-5.5 openai-codex/gpt-5.5 openai-codex/gpt-5.3-codex-spark --tokens 1200 --temperature 0.4",
        createCtx(cwd, notifications),
      );

      const saved = JSON.parse(readFileSync(targetRecipe, "utf8"));
      expect(saved.recipes[0]).toMatchObject({
        id: "hard-judge",
        model: "openai-codex/gpt-5.5",
        analysis_models: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.3-codex-spark"],
        max_completion_tokens: 1200,
        temperature: 0.4,
      });
      expect(notifications.at(-1)?.message).toContain("Run /pi-rogue-fusion reload or restart Pi");
      expect(notifications.at(-1)?.message).toContain("/pi-rogue-router models");
    } finally {
      if (prev === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES; else process.env.PI_ROGUE_FUSION_RECIPES = prev;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("offers configure and scoped model completions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-completions-"));
    try {
      const { pi, commands } = createPiMock();
      registerFusion(pi);
      const fusion = commands.get("pi-rogue-fusion");
      expect(fusion.getArgumentCompletions("con", createCtx(cwd)).map((item: any) => item.value)).toContain("configure");
      expect(fusion.getArgumentCompletions("configure ", createCtx(cwd)).map((item: any) => item.value)).toEqual(expect.arrayContaining(["add", "edit", "remove", "help"]));
      expect(fusion.getArgumentCompletions("configure add hard open", createCtx(cwd)).map((item: any) => item.value)).toEqual(expect.arrayContaining(["openai-codex/gpt-5.5", "openai-codex/gpt-5.3-codex-spark"]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("offers on/off completions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-onoff-"));
    try {
      const { pi, commands } = createPiMock();
      registerFusion(pi);
      const fusion = commands.get("pi-rogue-fusion");
      const completions = fusion.getArgumentCompletions("", createCtx(cwd)).map((item: any) => item.value);
      expect(completions).toContain("on");
      expect(completions).toContain("off");
      expect(completions).toContain("status");
      expect(completions).toContain("reload");
      expect(completions).toContain("configure");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tracks active → off → inactive → on → active status in one session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-off-"));
    const target = join(cwd, "recipes.json");
    const previous = process.env.PI_ROGUE_FUSION_RECIPES;
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      process.env.PI_ROGUE_FUSION_RECIPES = target;
      writeFileSync(target, JSON.stringify({ recipes: [{ schema: "pi-rogue.fusion.recipe.v1", kind: "fusion", id: "status-test", model: "openai-codex/gpt-5.5", analysis_models: ["openai-codex/gpt-5.5"] }] }));
      const { pi, commands, providers } = createPiMock();
      registerFusion(pi);
      const fusion = commands.get("pi-rogue-fusion");
      expect(providers.has("fusion")).toBe(true);
      await fusion.handler("status", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toContain("fusion: active (provider registered");

      await fusion.handler("off", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toBe("fusion provider disabled");
      expect(providers.has("fusion")).toBe(false);
      await fusion.handler("status", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toContain("fusion: inactive (provider not registered in this session)");

      await fusion.handler("on", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toContain("fusion provider re-enabled");
      expect(providers.has("fusion")).toBe(true);
      await fusion.handler("status", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toContain("fusion: active (provider registered");
    } finally {
      if (previous === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES;
      else process.env.PI_ROGUE_FUSION_RECIPES = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("/pi-rogue-fusion on re-registers the fusion provider", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-on-"));
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      const { pi, commands, providers } = createPiMock();
      registerFusion(pi);
      const fusion = commands.get("pi-rogue-fusion");
      await fusion.handler("off", createCtx(cwd, notifications));
      expect(providers.has("fusion")).toBe(false);
      // Now turn it on again
      notifications.length = 0;
      await fusion.handler("on", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toContain("fusion provider remains inactive (no valid recipes found)");
      expect(providers.has("fusion")).toBe(false);
      await fusion.handler("status", createCtx(cwd, notifications));
      expect(notifications.at(-1)?.message).toContain("fusion: inactive");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("documents effective user-root recipe and trace paths", () => {
    const readme = readFileSync(join(process.cwd(), "packages", "fusion", "README.md"), "utf8");
    expect(readme).toContain("~/.pi/agent/pi-rogue/fusion/recipes.json");
    expect(readme).toContain("$PI_ROGUE_FUSION_TRACE_DIR");
    expect(readme).toContain("~/.pi/agent/pi-rogue/fusion/runs/*.json");
    expect(readme).not.toContain("2. `.pi-rogue/fusion/recipes.json`");
  });

  it("wraps runner failures in the streamed error message", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-stream-error-"));
    const target = join(cwd, "recipes.json");
    const prev = process.env.PI_ROGUE_FUSION_RECIPES;
    try {
      process.env.PI_ROGUE_FUSION_RECIPES = target;
      writeFileSync(target, JSON.stringify({ recipes: [{
        schema: "pi-rogue.fusion.recipe.v1",
        kind: "fusion",
        id: "hard-judge",
        model: "openai-codex/gpt-5.5",
        analysis_models: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.3-codex-spark"],
      }] }, null, 2));
      completeSimpleMock.mockRejectedValue(new Error("down"));

      const { pi, handlers, providers } = createPiMock();
      registerFusion(pi);
      handlers.get("session_start")?.[0]?.({}, createCtx(cwd));

      const provider = providers.get("fusion");
      const model = provider.models[0];
      const stream = provider.streamSimple(model, createCtx(cwd), {});
      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
        if (event.type === "error") break;
      }
      const output = await stream.result();

      expect(output.stopReason).toBe("error");
      expect(output.content[0]?.type).toBe("text");
      expect(output.content[0] && "text" in output.content[0] ? output.content[0].text : "").toContain("Fusion failed: panel quorum not met");
      expect(output.errorMessage).toContain("panel quorum not met: panel models total=2, successful=0");
      expect(output.errorMessage).toContain("minimum required 2");
      expect(events.some((event) => event.type === "error")).toBe(true);
    } finally {
      completeSimpleMock.mockReset();
      if (prev === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES; else process.env.PI_ROGUE_FUSION_RECIPES = prev;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps an in-flight fusion run bound to its originating session", async () => {
    const cwdA = mkdtempSync(join(tmpdir(), "fusion-session-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "fusion-session-b-"));
    const target = join(cwdA, "recipes.json");
    const previous = process.env.PI_ROGUE_FUSION_RECIPES;
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    try {
      process.env.PI_ROGUE_FUSION_RECIPES = target;
      writeFileSync(target, JSON.stringify({ recipes: [{
        schema: "pi-rogue.fusion.recipe.v1",
        kind: "fusion",
        id: "session-bound",
        model: "openai-codex/gpt-5.5",
        analysis_models: ["openai-codex/gpt-5.5"],
      }] }));
      completeSimpleMock.mockImplementation(async () => {
        await completionGate;
        return {
          content: [{ type: "text", text: "Substantive session-bound response." }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        };
      });

      const { pi, handlers, providers } = createPiMock();
      const publish = vi.fn();
      pi.__piRogueContextBroker = {
        sessionId: (ctx: any) => ctx.sessionManager.getSessionFile(),
        publish,
      };
      registerFusion(pi);
      const ctxA: any = createCtx(cwdA);
      ctxA.sessionManager = { getSessionFile: () => "/sessions/a.jsonl" };
      const ctxB: any = createCtx(cwdB);
      ctxB.sessionManager = { getSessionFile: () => "/sessions/b.jsonl" };
      handlers.get("session_start")?.[0]?.({}, ctxA);

      const provider = providers.get("fusion");
      const stream = provider.streamSimple(provider.models[0], { messages: [] }, {});
      ctxA.sessionManager.getSessionFile = () => { throw new Error("stale session context"); };
      handlers.get("session_start")?.[0]?.({}, ctxB);
      releaseCompletion();
      await stream.result();

      expect(publish).toHaveBeenCalled();
      expect(publish.mock.calls.every((call) => call[0].sessionId === "/sessions/a.jsonl")).toBe(true);
      expect(publish.mock.calls.some((call) => call[0].sessionId === "/sessions/b.jsonl")).toBe(false);
    } finally {
      completeSimpleMock.mockReset();
      if (previous === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES;
      else process.env.PI_ROGUE_FUSION_RECIPES = previous;
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });

  it("/pi-rogue-fusion configure help lists scoped session models", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-help-"));
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      const { pi, commands } = createPiMock();
      registerFusion(pi);
      await commands.get("pi-rogue-fusion").handler("configure", createCtx(cwd, notifications));
      const message = notifications.at(-1)?.message ?? "";
      expect(message).toContain("openai-codex/gpt-5.5");
      expect(message).toContain("openai-codex/gpt-5.3-codex-spark");
      expect(message).not.toContain("image-only/paint");
      expect(message).toContain("Natural-language configure intent will be added later");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
