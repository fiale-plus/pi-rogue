import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildResearchGoal, buildResearchLoopInstruction, registerAutoresearch } from "./autoresearch.js";
import { formatResearchState, type ResearchState } from "./autoresearch-state.js";
import { clearLoop } from "./loop.js";

vi.mock("./advisor-checkins.js", () => ({
  resetAdvisorSessionContext: vi.fn(),
  setAdvisorCheckinsEnabled: vi.fn(),
}));

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
  it("surfaces backing loop and completion-guard counters", () => {
    const state: ResearchState = {
      kind: "autoresearch",
      instruction: "possible improvements for pi-rogue-orchestration",
      goal: "Autoresearch: possible improvements for pi-rogue-orchestration",
      loopInstruction: "Run one autoresearch cycle",
      interval: "5m",
      cycles: 1,
      doneAttempts: 1,
      lastResult: "done",
      updatedAt: "2026-05-26T00:00:00.000Z",
    };

    const text = formatResearchState(state);

    expect(text).toContain("backed by /goal + /loop 5m");
    expect(text).toContain("cycles=1");
    expect(text).toContain("doneAttempts=1");
    expect(text).toContain("last=done");
  });

  it("keeps empty state concise", () => {
    expect(formatResearchState({ kind: "autoresearch", instruction: "", updatedAt: "" })).toBe("🔎 Autoresearch is off.");
  });

  it("requires setup before autoresearch implementation", () => {
    const goal = buildResearchGoal("autoresearch", "improve advisor escalation");
    const loop = buildResearchLoopInstruction("autoresearch", "improve advisor escalation");

    expect(goal).toContain("Setup gate before implementation:");
    expect(goal).toContain("measurable target");
    expect(goal).toContain("benchmark/evaluation command");
    expect(goal).toContain("baseline/current state");
    expect(goal).toContain("durable artifact/log");
    expect(goal).toContain("do not simplify, re-aim, or replace the user objective");
    expect(loop).toContain("Before changing code, confirm or create the setup");
    expect(loop).toContain("If no metric or benchmark exists");
    expect(loop).toContain("preserve the active research question");
  });

  it("requires lane setup before autoresearch-lab integration", () => {
    const goal = buildResearchGoal("autoresearch-lab", "compare advisor lanes");
    const loop = buildResearchLoopInstruction("autoresearch-lab", "compare advisor lanes");

    expect(goal).toContain("source seed/objective");
    expect(goal).toContain("split the scope into independent lanes");
    expect(goal).toContain("hypothesis, eval method, and expected artifact");
    expect(goal).toContain("convergent findings");
    expect(loop).toContain("lane split");
    expect(loop).toContain("integrate only safe non-conflicting improvements");
    expect(loop).toContain("Do not simplify or re-aim the objective");
  });

  it("does not queue a duplicate cycle for the same active autoresearch instruction", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sent: string[] = [];
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "autoresearch") handler = command.handler;
      },
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();

    registerAutoresearch(pi);
    expect(handler).toBeTypeOf("function");
    await handler?.("improve repetition handling", ctx);
    await handler?.("improve repetition handling", ctx);

    expect(sent).toHaveLength(1);
    expect(ctx.notifications.at(-1)).toContain("already active");
  });

  it("requeues the same autoresearch instruction when the backing loop is stale", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sent: string[] = [];
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "autoresearch") handler = command.handler;
      },
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();

    registerAutoresearch(pi);
    await handler?.("improve stale loop recovery", ctx);
    clearLoop(ctx, { preserveCheckins: true });
    await handler?.("improve stale loop recovery", ctx);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("improve stale loop recovery");
  });
});
