import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoopState = {
  enabled: boolean;
  interval: string;
  instruction: string;
  updatedAt: string;
  generation: number;
};

const loopHarness = vi.hoisted(() => ({
  state: {
    enabled: false,
    interval: "",
    instruction: "",
    updatedAt: "",
    generation: 0,
  } as LoopState,
  reads: [] as LoopState[],
}));

vi.mock("./state.js", () => ({
  readSessionJson: vi.fn((_feature: string, _ctx: any, _file: string, fallback: LoopState) => {
    if (loopHarness.reads.length > 0) return loopHarness.reads.shift()!;
    return loopHarness.state ?? fallback;
  }),
  writeSessionJson: vi.fn((_feature: string, _ctx: any, _file: string, value: unknown) => {
    loopHarness.state = value as LoopState;
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  loopHarness.state = {
    enabled: false,
    interval: "",
    instruction: "",
    updatedAt: "",
    generation: 0,
  };
  loopHarness.reads = [];
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadLoopModule() {
  const home = mkdtempSync(join(tmpdir(), "pi-rogue-loop-home-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  return import("./loop.js");
}

function createContext(sessionName: string, runtime: { idle: boolean; pending: boolean } = { idle: true, pending: false }) {
  const notifications: string[] = [];
  return {
    notifications,
    isIdle: () => runtime.idle,
    hasPendingMessages: () => runtime.pending,
    sessionManager: {
      getSessionFile: () => join(tmpdir(), `${sessionName}.jsonl`),
    },
    ui: {
      setStatus: () => undefined,
      notify: (message: string) => {
        notifications.push(message);
        return 0;
      },
    },
  };
}

function activeState(interval: string, instruction: string, generation = 1): LoopState {
  return {
    enabled: true,
    interval,
    instruction,
    updatedAt: "2026-06-21T00:00:00.000Z",
    generation,
  };
}

function clearedState(generation = 2): LoopState {
  return {
    enabled: false,
    interval: "",
    instruction: "",
    updatedAt: "2026-06-21T00:00:00.000Z",
    generation,
  };
}

describe("loop tick guards", () => {
  it("allows only one outstanding tick while work exceeds two intervals", async () => {
    vi.useFakeTimers();
    const { registerLoop, startLoop } = await loadLoopModule();
    const runtime = { idle: true, pending: false };
    const ctx = createContext("long-running-tick", runtime);
    const sends: string[] = [];
    const handlers: Record<string, Array<(event: any, ctx: any) => void>> = {};
    const pi = {
      sendUserMessage: (message: string) => {
        sends.push(message);
        runtime.idle = false;
      },
      on: (name: string, handler: (event: any, ctx: any) => void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
    };

    registerLoop(pi as any);
    startLoop(pi as any, ctx, "1m", "inspect the long-running task");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("inspect the long-running task");

    runtime.idle = true;
    handlers.agent_end?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(1);

    handlers.agent_end?.[0]?.({ messages: [{ role: "user", content: [{ type: "text", text: sends[0] }] }] }, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(2);
  });

  it("skips ticks while a host message is pending", async () => {
    vi.useFakeTimers();
    const { clearLoop, startLoop } = await loadLoopModule();
    const runtime = { idle: true, pending: true };
    const ctx = createContext("host-pending", runtime);
    const sends: string[] = [];
    const pi = { sendUserMessage: (message: string) => sends.push(message), on: () => undefined };

    startLoop(pi as any, ctx, "1m", "wait for host work");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sends).toHaveLength(0);

    runtime.pending = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("wait for host work");
    clearLoop(ctx);
  });

  it("invalidates an outstanding tick when stopped and replaced while busy", async () => {
    vi.useFakeTimers();
    const { clearLoop, registerLoop, startLoop } = await loadLoopModule();
    const runtime = { idle: true, pending: false };
    const ctx = createContext("replace-busy", runtime);
    const sends: string[] = [];
    const handlers: Record<string, Array<(event: any, ctx: any) => void>> = {};
    const pi = {
      sendUserMessage: (message: string) => {
        sends.push(message);
        runtime.idle = false;
      },
      on: (name: string, handler: (event: any, ctx: any) => void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
    };

    registerLoop(pi as any);
    startLoop(pi as any, ctx, "1m", "old work");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("old work");
    const oldPrompt = sends[0];

    clearLoop(ctx);
    startLoop(pi as any, ctx, "1m", "replacement work");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sends).toHaveLength(1);

    handlers.agent_end?.[0]?.({ messages: [{ role: "user", content: oldPrompt }] }, ctx);
    runtime.idle = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain("replacement work");
    clearLoop(ctx);
  });

  it("skips sending when the loop is cleared after the tick starts", async () => {
    const { clearLoop, startLoop, triggerLoopTick } = await loadLoopModule();
    const ctx = createContext("clear-mid-tick");
    const sends: string[] = [];
    const pi = {
      sendUserMessage: (message: string) => sends.push(message),
      on: () => undefined,
    };

    startLoop(pi as any, ctx, "1m", "keep checking the system");
    loopHarness.reads = [activeState("1m", "keep checking the system", 1), clearedState(2)];

    const result = triggerLoopTick(pi as any, ctx);

    expect(result).toBe(false);
    expect(sends).toHaveLength(0);
    clearLoop(ctx);
  });

  it("skips sending when the loop is replaced after the tick starts", async () => {
    const { clearLoop, startLoop, triggerLoopTick } = await loadLoopModule();
    const ctx = createContext("replace-mid-tick");
    const sends: string[] = [];
    const pi = {
      sendUserMessage: (message: string) => sends.push(message),
      on: () => undefined,
    };

    startLoop(pi as any, ctx, "1m", "first instruction");
    loopHarness.reads = [activeState("1m", "first instruction", 1), activeState("1m", "updated instruction", 2)];

    const result = triggerLoopTick(pi as any, ctx);

    expect(result).toBe(false);
    expect(sends).toHaveLength(0);
    clearLoop(ctx);
  });

  it("clears failed goal enqueue state so a later loop tick retries", async () => {
    const { clearLoop, startLoop, triggerLoopTick } = await loadLoopModule();
    const { setGoal } = await import("./goal.js");
    const { endGoalCheck, hasGoalCheckPending } = await import("./goal-resolution.js");
    const ctx = createContext("goal-enqueue-retry");
    const sends: string[] = [];
    let attempts = 0;
    const pi = {
      sendUserMessage: (message: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient enqueue failure");
        sends.push(message);
      },
      on: () => undefined,
    };

    setGoal(ctx, "retry the goal delivery");
    startLoop(pi as any, ctx, "1m", "re-check the goal");
    expect(triggerLoopTick(pi as any, ctx)).toBe(false);
    expect(hasGoalCheckPending(ctx)).toBe(false);
    expect(ctx.notifications.at(-1)).toContain("will retry");

    expect(triggerLoopTick(pi as any, ctx)).toBe(true);
    expect(hasGoalCheckPending(ctx)).toBe(true);
    expect(sends).toHaveLength(1);
    endGoalCheck(ctx);
    clearLoop(ctx);
  });

  it("retries a goal loop after an undelivered enqueue lease expires", async () => {
    vi.useFakeTimers();
    const { clearLoop, startLoop, triggerLoopTick } = await loadLoopModule();
    const { setGoal } = await import("./goal.js");
    const { endGoalCheck, GOAL_CHECK_DELIVERY_LEASE_MS, hasGoalCheckPending } = await import("./goal-resolution.js");
    const ctx = createContext("goal-hidden-enqueue-retry");
    let attempts = 0;
    const pi = {
      sendUserMessage: () => {
        attempts += 1;
        void Promise.reject(new Error("hidden async enqueue failure")).catch(() => undefined);
      },
      on: () => undefined,
    };

    setGoal(ctx, "retry hidden loop delivery");
    startLoop(pi as any, ctx, "1m", "re-check the goal");
    expect(triggerLoopTick(pi as any, ctx)).toBe(true);
    expect(hasGoalCheckPending(ctx)).toBe(true);
    vi.setSystemTime(Date.now() + GOAL_CHECK_DELIVERY_LEASE_MS);
    expect(triggerLoopTick(pi as any, ctx)).toBe(true);
    expect(attempts).toBe(2);
    endGoalCheck(ctx);
    clearLoop(ctx);
  });

  it("does not leave goal check pending when a goal tick is superseded", async () => {
    const { clearLoop, startLoop, triggerLoopTick } = await loadLoopModule();
    const { setGoal } = await import("./goal.js");
    const { hasGoalCheckPending } = await import("./goal-resolution.js");
    const ctx = createContext("goal-mid-tick");
    const sends: string[] = [];
    const pi = {
      sendUserMessage: (message: string) => sends.push(message),
      on: () => undefined,
    };

    setGoal(ctx, "keep orchestration stable");
    startLoop(pi as any, ctx, "1m", "re-check the goal");
    loopHarness.reads = [activeState("1m", "re-check the goal", 1), clearedState(2)];

    const result = triggerLoopTick(pi as any, ctx);

    expect(result).toBe(false);
    expect(sends).toHaveLength(0);
    expect(hasGoalCheckPending(ctx)).toBe(false);
    clearLoop(ctx);
  });
});
