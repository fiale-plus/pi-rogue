import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routerArgumentCompletions } from "./completions.js";
import { activeProfile, cycleRouterProfile, ensureRouterConfig, loadRouterConfig, routerConfigPath, setRouterProfile } from "./config.js";
import { registerRouter } from "./extension.js";
import { decideRoute } from "./decision.js";
import { summarizeRouterDecision } from "./observe.js";
import type { RouterCheckpoint } from "./types.js";

function ctxMock() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-router-ext-"));
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    cwd,
    notifications,
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  };
}

function piMock() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const pi: any = {
    registerCommand(name: string, options: any) { commands.set(name, options); },
    registerShortcut(key: string, options: any) { shortcuts.set(key, options); },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  return { pi, commands, shortcuts, handlers };
}

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
    expect(activeProfile(config).worker).toBe("openai-codex/gpt-5.5");
    expect(readFileSync(routerConfigPath(ctx), "utf8")).toContain("spark-smart");
  });

  it("sets and cycles profiles", () => {
    const config = loadRouterConfig(ctxMock());
    const spark = setRouterProfile(config, "spark-smart");

    expect(spark?.activeProfile).toBe("spark-smart");
    expect(cycleRouterProfile(spark!, 1).activeProfile).toBe("local-smart");
    expect(setRouterProfile(config, "missing")).toBeNull();
  });

  it("completes router commands and profile names", () => {
    expect(routerArgumentCompletions("")?.map((item) => item.value)).toEqual(expect.arrayContaining(["on", "off", "status", "profile"]));
    expect(routerArgumentCompletions("profile s")?.map((item) => item.value)).toEqual(["profile spark-smart"]);
  });
});

describe("router extension", () => {
  it("registers slash command, ctrl-p profile cycling, and observe hook", async () => {
    const { pi, commands, shortcuts, handlers } = piMock();
    const ctx = ctxMock();

    registerRouter(pi);

    expect(commands.has("router")).toBe(true);
    expect(shortcuts.has("ctrl+alt+p")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);

    await commands.get("router").handler("on", ctx);
    expect(loadRouterConfig(ctx).enabled).toBe(true);

    await commands.get("router").handler("profile spark-smart", ctx);
    expect(loadRouterConfig(ctx).activeProfile).toBe("spark-smart");

    await shortcuts.get("ctrl+alt+p").handler(ctx);
    expect(loadRouterConfig(ctx).activeProfile).toBe("local-smart");
  });

  it("formats observe-only mismatch summaries without changing models", () => {
    const config = { ...loadRouterConfig(ctxMock()), enabled: true, activeProfile: "spark-smart" };
    const item = checkpoint();
    const summary = summarizeRouterDecision(item, decideRoute(item), config);

    expect(summary.text).toContain("MISMATCH");
    expect(summary.text).toContain("smart(openai-codex/gpt-5.5)");
    expect(summary.text).toContain("current=gpt-5.3-codex-spark");
  });
});
