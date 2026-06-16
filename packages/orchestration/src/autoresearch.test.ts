import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAdvisorCheckinsEnabled } from "./advisor-checkins.js";
import { buildResearchGoal, buildResearchLoopInstruction } from "./autoresearch.js";
import { registerOrchestration } from "./extension.js";
import { formatResearchState, type ResearchState } from "./autoresearch-state.js";
import { clearLoop } from "./loop.js";

vi.mock("./advisor-checkins.js", () => ({
  resetAdvisorSessionContext: vi.fn(),
  setAdvisorCheckinsEnabled: vi.fn(),
}));

const setAdvisorCheckinsEnabledMock = vi.mocked(setAdvisorCheckinsEnabled);

function fakeCtx(id = randomUUID()) {
  const notifications: string[] = [];
  return {
    notifications,
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => `/tmp/pi-rogue-autoresearch-test-${id}.jsonl`,
    },
    ui: {
      setStatus: () => undefined,
      notify: (message: string) => notifications.push(message),
    },
  };
}

describe("autoresearch status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces backing loop and cycle count", () => {
    const state: ResearchState = {
      kind: "autoresearch",
      instruction: "possible improvements for pi-rogue-orchestration",
      goal: "Autoresearch: possible improvements for pi-rogue-orchestration",
      loopInstruction: "Run one autoresearch cycle",
      interval: "5m",
      cycles: 1,
      lastResult: "done",
      updatedAt: "2026-05-26T00:00:00.000Z",
    };

    const text = formatResearchState(state);

    expect(text).toContain("/pi-rogue-orchestration loop 5m");
    expect(text).toContain("cycles=1");
    expect(text).toContain("last=done");
  });

  it("keeps empty state concise", () => {
    expect(formatResearchState({ kind: "autoresearch", instruction: "", updatedAt: "" })).toBe("🔎 Autoresearch is off.");
  });

  it("keeps autoresearch prompts direct", () => {
    const goal = buildResearchGoal("autoresearch", "improve advisor escalation");
    const loop = buildResearchLoopInstruction("autoresearch", "improve advisor escalation");

    expect(goal).toContain("measurable target");
    expect(goal).toContain("eval/check command");
    expect(goal).toContain("durable artifact/log");
    expect(goal).toContain("Preserve the user objective");
    expect(goal).toContain("summarized with evidence");
    expect(loop).toContain("Confirm/update hypothesis");
    expect(loop).toContain("take one concrete high-leverage step");
    expect(loop).toContain("record result");
    expect(loop).toContain("Do not simplify or re-aim");
  });

  it("keeps autoresearch-lab prompts direct", () => {
    const goal = buildResearchGoal("autoresearch-lab", "compare advisor lanes");
    const loop = buildResearchLoopInstruction("autoresearch-lab", "compare advisor lanes");

    expect(goal).toContain("source objective");
    expect(goal).toContain("lane split");
    expect(goal).toContain("evaluate evidence before integration");
    expect(goal).toContain("convergent findings");
    expect(loop).toContain("Advance the most useful lane comparison");
    expect(loop).toContain("integrate only safe improvements");
    expect(loop).toContain("Do not simplify or re-aim");
  });

  it("does not queue a duplicate cycle for the same active autoresearch instruction", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sent: string[] = [];
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "pi-rogue-orchestration") handler = command.handler;
      },
      sendUserMessage: (text: string) => sent.push(text),
      on: () => undefined,
    } as any;
    const ctx = fakeCtx();

    registerOrchestration(pi);
    expect(handler).toBeTypeOf("function");
    await handler?.("autoresearch improve repetition handling", ctx);
    await handler?.("autoresearch improve repetition handling", ctx);

    expect(sent).toHaveLength(1);
    expect(ctx.notifications.at(-1)).toContain("already active");
  });

  it("requeues the same autoresearch instruction when the backing loop is stale", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sent: string[] = [];
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "pi-rogue-orchestration") handler = command.handler;
      },
      sendUserMessage: (text: string) => sent.push(text),
      on: () => undefined,
    } as any;
    const ctx = fakeCtx();

    registerOrchestration(pi);
    await handler?.("autoresearch improve stale loop recovery", ctx);
    clearLoop(ctx, { preserveCheckins: true });
    await handler?.("autoresearch improve stale loop recovery", ctx);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("improve stale loop recovery");
  });

  it("disables advisor check-ins when orchestration autoresearch clear stops the loop", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "pi-rogue-orchestration") handler = command.handler;
      },
      sendUserMessage: () => undefined,
      on: () => undefined,
    } as any;
    const ctx = fakeCtx();

    registerOrchestration(pi);
    await handler?.("autoresearch improve lifecycle cleanup", ctx);
    setAdvisorCheckinsEnabledMock.mockClear();
    await handler?.("autoresearch clear", ctx);

    expect(setAdvisorCheckinsEnabledMock).toHaveBeenCalledWith(false);
  });
});
