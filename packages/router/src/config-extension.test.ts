import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routerArgumentCompletions } from "./completions.js";
import {
  activeProfile,
  cycleRouterProfile,
  ensureRouterConfig,
  loadRouterConfig,
  loadRouterState,
  normalizeRouterConfig,
  routerConfigPath,
  routerEventsPath,
  routerGlobalConfigPath,
  routerSessionDir,
  routerStatePath,
  saveRouterConfig,
  setRouterMode,
  setRouterPrint,
  setRouterProfile,
} from "./config.js";
import type { RouterState } from "./config.js";
import { registerRouter } from "./extension.js";
import { decideRoute } from "./decision.js";
import { applyModelRouting, modelsMatch, observeRouterTurn, planAutoModelDowngrade, planAutoModelSwitch, summarizeRouterDecision } from "./observe.js";
import type { RouterCheckpoint } from "./types.js";

function ctxMock(sessionPath?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-router-ext-"));
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    cwd,
    notifications,
    sessionManager: sessionPath ? { getSessionFile: () => sessionPath } : undefined,
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  };
}

function writeSessionFixture(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, [
    JSON.stringify({ type: "session", id: name, cwd: dir }),
    JSON.stringify({ type: "message", id: `${name}-user`, message: { role: "user", content: [{ type: "text", text: "please implement a small fix" }] } }),
  ].join("\n") + "\n");
  return path;
}

function appendSessionEvent(path: string, event: unknown): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

function appendAutoModelTurn(path: string, model: string): void {
  appendSessionEvent(path, {
    type: "message",
    id: `assistant-${Date.now()}`,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "progress is good" }],
      provider: "openai-codex",
      model,
      usage: { input_tokens: 120_000 },
    },
  });
}

function piMock() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const selectedModels: any[] = [];
  const pi: any = {
    selectedModels,
    async setModel(model: any) { selectedModels.push(model); return true; },
    registerCommand(name: string, options: any) { commands.set(name, options); },
    registerShortcut(key: string, options: any) { shortcuts.set(key, options); },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  return { pi, commands, shortcuts, handlers };
}

const oldHome = process.env.HOME;
let isolatedHome = "";

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), "pi-router-home-"));
  process.env.HOME = isolatedHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
  isolatedHome = "";
});

function checkpoint(overrides: Partial<RouterCheckpoint> = {}): RouterCheckpoint {
  const base: RouterCheckpoint = {
    schema: "pi-router.checkpoint.v1",
    sessionId: "session-1",
    checkpointId: "session-1:event-1",
    createdAt: "2026-06-12T00:00:00.000Z",
    rawSessionRef: { schema: "pi-router.raw-session-ref.v1", path: "/tmp/session.jsonl", fromEvent: 0, toEvent: 1, fromByte: 0, toByte: 10, contentHash: "hash" },
    harness: "pi",
    phase: "debug",
    activeModel: "gpt-5.3-codex-spark",
    provider: "openai-codex",
    features: {
      turnIndex: 1,
      sameCommandRepeatedCount: 2,
      sameErrorRepeatedCount: 2,
      errorChanged: false,
      testsImproved: null,
      filesTouched: 1,
      diffLines: 0,
      diffFilesChanged: 0,
      diffLinesAdded: 0,
      diffLinesDeleted: 0,
      diffChurnScore: 0,
      toolThrashScore: 0.2,
      goalDriftScore: 0,
      loopScore: 0.55,
      progressScore: 0.45,
      verifierUsed: true,
      noVerifierUsed: false,
      toolCallsLast10Turns: 4,
      contextTokensApprox: 1000,
      gitDirty: null,
    },
    recent: { touchedFileHashes: [] },
    sourceEvent: { index: 1, byteStart: 0, byteEnd: 10, type: "message", role: "toolResult" },
  };
  return { ...base, ...overrides, features: { ...base.features, ...(overrides.features ?? {}) } };
}

describe("router config profiles", () => {
  it("creates default all-smart/spark/local profiles", () => {
    const ctx = ctxMock();
    const config = ensureRouterConfig(ctx);

    expect(config.activeProfile).toBe("all-smart");
    expect(config.profileOrder).toEqual(["all-smart", "spark-smart", "local-smart"]);
    expect(config.mode).toBe("observe");
    expect(config.autoModel).toEqual(
      expect.objectContaining({
        minConfidence: 0.7,
        requiredConsecutiveMismatches: 2,
        minCooldownSeconds: 30,
        maxSwitchesPerWindow: 3,
        switchWindowSeconds: 300,
      }),
    );
    expect(activeProfile(config).worker).toBe("openai-codex/gpt-5.5");
    expect(readFileSync(routerConfigPath(ctx), "utf8")).toContain("spark-smart");
  });

  it("migrates removed Fusion profiles and targets to direct models", () => {
    const config = normalizeRouterConfig({
      enabled: true,
      mode: "auto_model",
      activeProfile: "fusion-smart",
      profileOrder: ["fusion-smart", "quick"],
      profiles: {
        "fusion-smart": { worker: "fusion/old", smart: "fusion/old", teacher: "fusion/old", reviewer: "fusion/old" },
        quick: { worker: "fusion/quick", smart: "fusion/quick", teacher: "fusion/quick", reviewer: "fusion/quick" },
      },
    });

    expect(config.activeProfile).toBe("all-smart");
    expect(config.profileOrder).toEqual(["all-smart", "quick"]);
    expect(config.profiles["fusion-smart"]).toBeUndefined();
    expect(config.profiles["all-smart"]).toMatchObject({
      worker: "openai-codex/gpt-5.5",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
    });
    expect(config.profiles.quick.worker).toBe("openai-codex/gpt-5.5");
  });

  it("reads and writes user-root config only", () => {
    const ctx = ctxMock();
    const globalPath = routerGlobalConfigPath();
    mkdirSync(join(globalPath, ".."), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({
      enabled: true,
      mode: "auto_model",
      activeProfile: "global-profile",
      profileOrder: ["global-profile"],
      profiles: {
        "global-profile": { worker: "global-worker", smart: "global-smart", teacher: "global-teacher", reviewer: "global-reviewer" },
      },
    }));

    expect(routerConfigPath(ctx)).toBe(globalPath);
    expect(loadRouterConfig(ctx)).toMatchObject({ enabled: true, mode: "auto_model", activeProfile: "global-profile" });

    saveRouterConfig(ctx, {
      ...loadRouterConfig(ctx),
      activeProfile: "user-profile",
      profileOrder: ["user-profile"],
      profiles: { "user-profile": { worker: "user-worker", smart: "user-smart", teacher: "user-teacher", reviewer: "user-reviewer" } },
    });

    const loaded = loadRouterConfig(ctx);
    expect(loaded.activeProfile).toBe("user-profile");
    expect(loaded.profiles["user-profile"].smart).toBe("user-smart");
  });

  it("sets and cycles profiles", () => {
    const config = loadRouterConfig(ctxMock());
    const spark = setRouterProfile(config, "spark-smart");

    expect(spark?.activeProfile).toBe("spark-smart");
    expect(cycleRouterProfile(spark!, 1).activeProfile).toBe("local-smart");
    expect(setRouterProfile(config, "missing")).toBeNull();
    expect(setRouterMode(config, "auto")?.mode).toBe("auto_model");
    expect(setRouterMode(config, "auto_model")?.mode).toBe("auto_model");
    expect(setRouterMode(config, "agent-auto")).toBeNull();
    expect(setRouterPrint(config, "all")?.print).toBe("all");
    expect(setRouterPrint(config, "noisy")).toBeNull();
  });

  it("completes router commands as a nested slash-menu tree", () => {
    const top = routerArgumentCompletions("") ?? [];

    expect(top.map((item) => item.value)).toEqual(["status", "help", "on", "off", "mode ", "profile ", "print ", "models", "profiles", "cycle", "configure"]);
    expect(top.find((item) => item.value === "mode ")?.label).toBe("mode …");
    expect(routerArgumentCompletions("profile s")?.map((item) => item.value)).toEqual(["profile spark-smart"]);
    expect(routerArgumentCompletions("mode a")?.map((item) => item.value)).toEqual(["mode auto_model"]);
    expect(routerArgumentCompletions("print ")?.map((item) => item.value)).toEqual(["print mismatch_only", "print all", "print off"]);
  });

  it.each([
    { print: "off" as const, model: "gpt-5.3-codex-spark", notifications: 0 },
    { print: "all" as const, model: "gpt-5.5", notifications: 1 },
    { print: "mismatch_only" as const, model: "gpt-5.5", notifications: 0 },
    { print: "mismatch_only" as const, model: "gpt-5.3-codex-spark", notifications: 1 },
  ])("keeps observation semantics with print=$print and model=$model", async ({ print, model, notifications }) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-router-print-"));
    const session = writeSessionFixture(cwd, `${print}-${model}.jsonl`);
    appendAutoModelTurn(session, model);
    const ctx = { ...ctxMock(session), cwd };
    saveRouterConfig(ctx, { ...loadRouterConfig(ctx), enabled: true, mode: "observe", print });

    const first = await observeRouterTurn(ctx);
    const duplicate = await observeRouterTurn(ctx);

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(loadRouterState(ctx, session).lastObservedCheckpointId).toBe(first?.checkpointId);
    expect(readFileSync(routerEventsPath(ctx, session), "utf8").trim().split("\n")).toHaveLength(1);
    expect(ctx.notifications).toHaveLength(notifications);
  });

  it("replays only session JSONL suffix when unchanged and reparses on truncation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-router-replay-"));
    const session = writeSessionFixture(cwd, "replay.jsonl");
    appendAutoModelTurn(session, "gpt-5.3-codex-spark");
    const ctx = { ...ctxMock(session), cwd };
    saveRouterConfig(ctx, { ...loadRouterConfig(ctx), enabled: true, mode: "observe", print: "off" });

    const first = await observeRouterTurn(ctx);
    expect(first).not.toBeNull();
    expect(loadRouterState(ctx, session).lastCheckpointReplayParse).toMatchObject({ source: "full", parsedEventCount: 3 });

    const duplicate = await observeRouterTurn(ctx);
    expect(duplicate).toBeNull();
    expect(loadRouterState(ctx, session).lastCheckpointReplayParse).toMatchObject({ source: "none", parsedEventCount: 0 });

    appendAutoModelTurn(session, "gpt-5.3-codex-spark");
    const replay = await observeRouterTurn(ctx);
    expect(replay).not.toBeNull();
    expect(loadRouterState(ctx, session).lastCheckpointReplayParse).toMatchObject({ source: "replay", parsedEventCount: 1 });

    const lines = readFileSync(session, "utf8").split("\n").filter((line) => line.trim());
    writeFileSync(session, `${lines[0]}\n${lines[1]}\n`);

    const fallback = await observeRouterTurn(ctx);
    expect(fallback).not.toBeNull();
    expect(loadRouterState(ctx, session).lastCheckpointReplayParse).toMatchObject({ source: "full", parsedEventCount: 2 });
  });

  it("keeps config repo-global while state and live events are session-scoped", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-router-sessions-"));
    const firstSession = writeSessionFixture(cwd, "session-a.jsonl");
    const secondSession = writeSessionFixture(cwd, "session-b.jsonl");
    const firstCtx = { ...ctxMock(firstSession), cwd };
    const secondCtx = { ...ctxMock(secondSession), cwd };
    saveRouterConfig(firstCtx, { ...loadRouterConfig(firstCtx), enabled: true, print: "all" });

    expect(routerConfigPath(firstCtx)).toBe(routerConfigPath(secondCtx));
    expect(routerStatePath(firstCtx, firstSession)).not.toBe(routerStatePath(secondCtx, secondSession));
    expect(routerEventsPath(firstCtx, firstSession)).not.toBe(routerEventsPath(secondCtx, secondSession));
    expect(routerSessionDir(firstCtx, firstSession)).toContain("session-a");

    await observeRouterTurn(firstCtx);
    await observeRouterTurn(secondCtx);

    expect(existsSync(routerStatePath(firstCtx, firstSession))).toBe(true);
    expect(existsSync(routerStatePath(secondCtx, secondSession))).toBe(true);
    expect(readFileSync(routerEventsPath(firstCtx, firstSession), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(routerEventsPath(secondCtx, secondSession), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("auto-model policy planning", () => {
  it("requires consecutive mismatches before applying auto-model switch", () => {
    const config = { ...loadRouterConfig(ctxMock()), enabled: true, activeProfile: "spark-smart", mode: "auto_model" as const };
    const baseSummary = summarizeRouterDecision(checkpoint(), decideRoute(checkpoint()), config);

    const first = planAutoModelSwitch(checkpoint(), baseSummary, {}, config.autoModel);
    expect(first.canApply).toBe(false);
    expect(first.reason).toContain("need 2 consecutive mismatches");

    const alreadyBuilding: RouterState = {
      autoModelPendingTarget: baseSummary.targetModel,
      autoModelPendingStreak: 1,
    };
    const second = planAutoModelSwitch(checkpoint(), baseSummary, alreadyBuilding, {
      ...config.autoModel,
      requiredConsecutiveMismatches: 2,
    });
    expect(second.canApply).toBe(true);
  });

  it("reverts an elevated current model back to worker after cooldown", () => {
    const config = { ...loadRouterConfig(ctxMock()), enabled: true, activeProfile: "spark-smart", mode: "auto_model" as const };
    const checkpointEvent = checkpoint({ activeModel: "openai-codex/gpt-5.5", provider: "openai-codex" });
    const summary = {
      checkpointId: checkpointEvent.checkpointId,
      action: "continue_current" as const,
      role: "current" as const,
      targetModel: checkpointEvent.activeModel,
      currentModel: checkpointEvent.activeModel,
      currentProvider: checkpointEvent.provider,
      match: true,
      confidence: 0.82,
      reason: "continue current",
      text: "router: MATCH continue_current → current(current) · current=openai-codex/gpt-5.5 · 0.82 · continue current",
    };
    const state: RouterState = {
      autoModelLastSwitchAt: new Date(Date.parse(checkpointEvent.createdAt) - 60_000).toISOString(),
      autoModelPendingTarget: checkpointEvent.activeModel,
      autoModelPendingStreak: 0,
      autoModelSwitchHistory: [new Date(Date.parse(checkpointEvent.createdAt) - 120_000).toISOString()],
    };

    const workerTarget = config.profiles[config.activeProfile].worker;
    const plan = planAutoModelDowngrade(checkpointEvent, summary, state, config.autoModel, workerTarget);

    expect(plan.canApply).toBe(true);
    expect(plan.reason).toContain("reverting to worker");
    expect(plan.statePatch.autoModelPendingTarget).toBe(workerTarget);
    expect(plan.statePatch.autoModelPendingStreak).toBe(0);
  });

  it("blocks auto-model switch during cooldown and window cap", () => {
    const config = { ...loadRouterConfig(ctxMock()), enabled: true, activeProfile: "spark-smart", mode: "auto_model" as const };
    const checkpointEvent = checkpoint();
    const summary = summarizeRouterDecision(checkpointEvent, decideRoute(checkpoint()), config);
    const nowMs = Date.parse(checkpointEvent.createdAt);
    const state: RouterState = {
      autoModelLastSwitchAt: new Date(nowMs).toISOString(),
      autoModelPendingTarget: summary.targetModel,
      autoModelPendingStreak: 1,
      autoModelSwitchHistory: [new Date(nowMs - 10_000).toISOString(), new Date(nowMs - 20_000).toISOString()],
    };

    const cooldown = planAutoModelSwitch(checkpoint(), summary, state, {
      ...config.autoModel,
      minCooldownSeconds: 60,
      requiredConsecutiveMismatches: 1,
    });
    expect(cooldown.canApply).toBe(false);
    expect(cooldown.reason).toContain("cooldown not elapsed");

    const capped = planAutoModelSwitch(checkpoint(), summary, state, {
      ...config.autoModel,
      maxSwitchesPerWindow: 1,
      requiredConsecutiveMismatches: 1,
      switchWindowSeconds: 60,
      minCooldownSeconds: 0,
    });
    expect(capped.canApply).toBe(false);
    expect(capped.reason).toContain("max auto-model flips exceeded");
  });
});

describe("router extension", () => {
  it("registers slash command, ctrl-alt-p profile cycling, and observe hook", async () => {
    const { pi, commands, shortcuts, handlers } = piMock();
    const ctx = ctxMock();

    registerRouter(pi);

    expect(commands.has("pi-rogue-router")).toBe(true);
    expect(shortcuts.has("ctrl+alt+p")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);

    await commands.get("pi-rogue-router").handler("on", ctx);
    expect(loadRouterConfig(ctx).enabled).toBe(true);

    await commands.get("pi-rogue-router").handler("profile spark-smart", ctx);
    expect(loadRouterConfig(ctx).activeProfile).toBe("spark-smart");
    expect(ctx.notifications.at(-1)?.text).toContain("router profile set: spark-smart");
    expect(ctx.notifications.at(-1)?.text).toContain("debug_diagnose=");
    await commands.get("pi-rogue-router").handler("profile", ctx);
    expect(ctx.notifications.at(-1)?.text).toContain("router profile: spark-smart");

    await commands.get("pi-rogue-router").handler("mode auto_model", ctx);
    expect(loadRouterConfig(ctx).mode).toBe("auto_model");
    await commands.get("pi-rogue-router").handler("print all", ctx);
    expect(loadRouterConfig(ctx).print).toBe("all");
    await commands.get("pi-rogue-router").handler("models", ctx);
    expect(ctx.notifications.at(-1)?.text).toContain("router models: spark-smart");
    expect(ctx.notifications.at(-1)?.text).toContain("worker:");
    await commands.get("pi-rogue-router").handler("help", ctx);
    expect(ctx.notifications.at(-1)?.text).toContain("router command tree:");
    await commands.get("pi-rogue-router").handler("off", ctx);
    await commands.get("pi-rogue-router").handler("on", ctx);
    expect(ctx.notifications.at(-1)?.text).toContain("auto_model applies model switches only");
    await commands.get("pi-rogue-router").handler("status", ctx);
    expect(ctx.notifications.at(-1)?.text).toContain("model routing: auto_model");

    await shortcuts.get("ctrl+alt+p").handler(ctx);
    expect(loadRouterConfig(ctx).activeProfile).toBe("local-smart");
    expect(ctx.notifications.at(-1)?.text).toContain("router profile cycled: local-smart");
  });

  it("documents user-root live paths separately from repo-local offline outputs", () => {
    const readme = readFileSync(join(process.cwd(), "packages", "router", "README.md"), "utf8");
    expect(readme).toContain("~/.pi/agent/pi-rogue/router/config.json");
    expect(readme).toContain("~/.pi/agent/pi-rogue/router/sessions/<session-key>/state.json");
    expect(readme).toContain("repo-local `.pi/router/*` experiment outputs");
    expect(readme).not.toContain("Live config is repo-global at `.pi/router/config.json`");
  });

  it("formats observe-only mismatch summaries without changing models", () => {
    const config = { ...loadRouterConfig(ctxMock()), enabled: true, activeProfile: "spark-smart" };
    const item = checkpoint();
    const summary = summarizeRouterDecision(item, decideRoute(item), config);

    expect(summary.text).toContain("MISMATCH");
    expect(summary.text).toContain("debug_diagnose(openai-codex/gpt-5.5)");
    expect(summary.text).toContain("current=gpt-5.3-codex-spark");
  });

  it("falls back optional live roles for compact four-role profiles", () => {
    const config = {
      ...loadRouterConfig(ctxMock()),
      activeProfile: "compact",
      profiles: {
        compact: {
          worker: "fast-worker",
          smart: "deep-smart",
          teacher: "deep-teacher",
          reviewer: "deep-reviewer",
        },
      },
      profileOrder: ["compact"],
    };
    const item = checkpoint({ activeModel: "current-model", provider: undefined });
    const verify = summarizeRouterDecision(item, { ...decideRoute(item), action: "run_verifier" }, config);
    const debug = summarizeRouterDecision(item, { ...decideRoute(item), action: "escalate_debug_diagnosis" }, config);
    const review = summarizeRouterDecision(item, { ...decideRoute(item), action: "escalate_diff_review" }, config);

    expect(verify).toMatchObject({ role: "verify", targetModel: "fast-worker" });
    expect(debug).toMatchObject({ role: "debug_diagnose", targetModel: "deep-smart" });
    expect(review).toMatchObject({ role: "review", targetModel: "deep-reviewer" });
  });

  it("waits for consecutive mismatches before auto-model switch", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-router-autoswitch-"));
    const sessionPath = writeSessionFixture(sessionDir, "autoswitch.jsonl");
    appendAutoModelTurn(sessionPath, "gpt-5.3-codex-spark");

    const { pi, commands, handlers } = piMock();
    const ctx = {
      ...ctxMock(sessionPath),
      cwd: sessionDir,
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id } : undefined,
        getAll: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
      },
    };

    registerRouter(pi);
    await commands.get("pi-rogue-router").handler("on", ctx);
    await commands.get("pi-rogue-router").handler("mode auto_model", ctx);

    const turn = handlers.get("turn_end")?.[0];
    expect(turn).toBeTypeOf("function");

    saveRouterConfig(ctx, {
      ...loadRouterConfig(ctx),
      autoModel: {
        ...loadRouterConfig(ctx).autoModel,
        requiredConsecutiveMismatches: 2,
      },
    });

    await turn?.(null, ctx);
    expect(pi.selectedModels).toHaveLength(0);
    expect(loadRouterState(ctx, sessionPath).autoModelPendingStreak).toBe(1);

    appendAutoModelTurn(sessionPath, "gpt-5.3-codex-spark");
    await turn?.(null, ctx);

    expect(pi.selectedModels).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
    expect(loadRouterState(ctx, sessionPath).autoModelLastSwitchAt).toBeDefined();
  });

  it("caps auto-model flips within a policy window", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-router-window-"));
    const sessionPath = writeSessionFixture(sessionDir, "window.jsonl");
    appendAutoModelTurn(sessionPath, "gpt-5.3-codex-spark");

    const { pi, commands, handlers } = piMock();
    const ctx = {
      ...ctxMock(sessionPath),
      cwd: sessionDir,
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id } : undefined,
        getAll: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
      },
    };

    registerRouter(pi);
    await commands.get("pi-rogue-router").handler("on", ctx);
    await commands.get("pi-rogue-router").handler("mode auto_model", ctx);

    const turn = handlers.get("turn_end")?.[0];
    expect(turn).toBeTypeOf("function");

    saveRouterConfig(ctx, {
      ...loadRouterConfig(ctx),
      autoModel: {
        ...loadRouterConfig(ctx).autoModel,
        requiredConsecutiveMismatches: 1,
        minCooldownSeconds: 0,
        maxSwitchesPerWindow: 1,
        switchWindowSeconds: 600,
      },
    });

    await turn?.(null, ctx);
    appendAutoModelTurn(sessionPath, "gpt-5.3-codex-spark");
    await turn?.(null, ctx);

    expect(pi.selectedModels).toHaveLength(1);
    const events = readFileSync(routerEventsPath(ctx, sessionPath), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events.at(-1)?.observed).toMatchObject({ followed: false, userOverrodeDecision: false, routingStatus: "policy_noop" });
    expect(events.at(-1)?.observed.routingReason).toBeTruthy();
    expect(events.at(-1)?.observed.overriddenBy).toBeUndefined();
  });

  it("auto_model applies only model switches for explicit target mismatches", async () => {
    const { pi } = piMock();
    const ctx = {
      ...ctxMock(),
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id } : undefined,
      },
    };
    const config = { ...loadRouterConfig(ctx), enabled: true, mode: "auto_model" as const, activeProfile: "spark-smart" };
    const item = checkpoint();
    const summary = summarizeRouterDecision(item, decideRoute(item), config);

    const applied = await applyModelRouting(pi, ctx, summary);

    expect(applied).toMatchObject({ applied: true, status: "applied", fromModel: "gpt-5.3-codex-spark", toModel: "openai-codex/gpt-5.5" });
    expect(pi.selectedModels).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);

    const none = await applyModelRouting(pi, ctx, { ...summary, role: "none", targetModel: undefined, match: null });
    expect(none.applied).toBe(false);
    expect(none.status).toBe("policy_noop");
    expect(pi.selectedModels).toHaveLength(1);
  });

  it("does not treat provider-qualified target as matched when only leaf model id matches", async () => {
    const { pi } = piMock();
    const ctx = {
      ...ctxMock(),
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id } : undefined,
      },
    };
    const config = { ...loadRouterConfig(ctx), enabled: true, mode: "auto_model" as const, activeProfile: "spark-smart" };
    const item = checkpoint({ activeModel: "gpt-5.5", provider: "custom" });
    const summary = summarizeRouterDecision(item, decideRoute(item), config);
    const qualifiedWithoutProvider = summarizeRouterDecision(checkpoint({ activeModel: "custom/gpt-5.5", provider: undefined }), decideRoute(item), config);
    const leafWithoutProvider = summarizeRouterDecision(checkpoint({ activeModel: "gpt-5.5", provider: undefined }), decideRoute(item), config);

    expect(summary.match).toBe(false);
    expect(qualifiedWithoutProvider.match).toBe(false);
    expect(leafWithoutProvider.match).toBe(false);
    expect(modelsMatch("zai/kimi-k2.6", "openrouter/moonshotai/kimi-k2.6", "openrouter")).toBe(false);
    expect(modelsMatch("openrouter/moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6")).toBe(false);
    expect(modelsMatch("moonshotai/kimi-k2.6", "openrouter/moonshotai/kimi-k2.6", "openrouter")).toBe(true);
    const applied = await applyModelRouting(pi, ctx, summary);

    expect(applied.applied).toBe(true);
    expect(applied.status).toBe("applied");
    expect(pi.selectedModels).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
  });

  it("resolves bare slash-containing model ids from the registry", async () => {
    const { pi } = piMock();
    const ctx = {
      ...ctxMock(),
      modelRegistry: {
        getAll: () => [{ provider: "openrouter", id: "moonshotai/kimi-k2.6" }],
        find: (provider: string, id: string) => ({ provider, id }),
      },
    };

    const applied = await applyModelRouting(pi, ctx, { checkpointId: "c", action: "ask_micro_hint", role: "smart", currentModel: "qwen", currentProvider: "openrouter", targetModel: "moonshotai/kimi-k2.6", match: false, confidence: 0.8, reason: "test", text: "test" });
    const skipped = await applyModelRouting(pi, ctx, { checkpointId: "c", action: "ask_micro_hint", role: "smart", currentModel: "moonshotai/kimi-k2.6", currentProvider: "openrouter", targetModel: "moonshotai/kimi-k2.6", match: false, confidence: 0.8, reason: "test", text: "test" });
    const duplicateProviderCtx = {
      ...ctxMock(),
      modelRegistry: {
        getAll: () => [{ provider: "first", id: "same-model" }, { provider: "current", id: "same-model" }],
      },
    };
    const duplicateSkipped = await applyModelRouting(pi, duplicateProviderCtx, { checkpointId: "c", action: "ask_micro_hint", role: "smart", currentModel: "same-model", currentProvider: "current", targetModel: "same-model", match: true, confidence: 0.8, reason: "test", text: "test" });

    const ambiguousCtx = {
      ...ctxMock(),
      modelRegistry: { getAll: () => [{ provider: "first", id: "ambiguous" }, { provider: "second", id: "ambiguous" }] },
    };
    const ambiguous = await applyModelRouting(pi, ambiguousCtx, { checkpointId: "c", action: "ask_micro_hint", role: "smart", currentModel: "other", targetModel: "ambiguous", match: false, confidence: 0.8, reason: "test", text: "test" });

    expect(applied.applied).toBe(true);
    expect(applied.status).toBe("applied");
    expect(skipped.applied).toBe(false);
    expect(skipped.status).toBe("policy_noop");
    expect(duplicateSkipped.applied).toBe(false);
    expect(duplicateSkipped.status).toBe("policy_noop");
    expect(ambiguous.applied).toBe(false);
    expect(ambiguous.status).toBe("blocked");
    expect(ambiguous.reason).toContain("target model not configured");
    expect(pi.selectedModels).toEqual([{ provider: "openrouter", id: "moonshotai/kimi-k2.6" }]);
  });
});
