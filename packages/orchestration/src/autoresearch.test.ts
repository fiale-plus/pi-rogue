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

    expect(text).toContain("/loop 5m");
    expect(text).toContain("cycles=1");
    expect(text).toContain("last=done");
  });

  it("keeps empty state concise", () => {
    expect(formatResearchState({ kind: "autoresearch", instruction: "", updatedAt: "" })).toBe("🔎 Autoresearch is off.");
  });

  it("keeps autoresearch prompts direct", () => {
    const goal = buildResearchGoal("autoresearch", "improve advisor escalation");
    const loop = buildResearchLoopInstruction("autoresearch", "improve advisor escalation");

    expect(goal).toContain("define the target/evidence");
    expect(goal).toContain("stop only with evidence");
    expect(loop).toContain("Inspect current state");
    expect(loop).toContain("take one concrete step");
    expect(loop).toContain("preserve the original objective");
  });

  it("keeps autoresearch-lab prompts direct", () => {
    const goal = buildResearchGoal("autoresearch-lab", "compare advisor lanes");
    const loop = buildResearchLoopInstruction("autoresearch-lab", "compare advisor lanes");

    expect(goal).toContain("Compare independent lanes");
    expect(goal).toContain("preserve the user objective");
    expect(loop).toContain("advance the most useful lane comparison");
    expect(loop).toContain("integrate only safe improvements");
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
