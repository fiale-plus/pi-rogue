import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAdvisorSessionContext, setAdvisorCheckinsEnabled } from "./advisor-checkins.js";
import { endGoalCheck } from "./goal-resolution.js";
import { activeGoal, clearGoal, completeActiveGoal, handleGoalCommand, registerGoal, setGoal, startGoalProcessing } from "./goal.js";
import { featureFile, readText, sessionFile, writeText } from "./internal.js";

vi.mock("./advisor-checkins.js", () => ({
  resetAdvisorSessionContext: vi.fn(),
  setAdvisorCheckinsEnabled: vi.fn(),
}));

const resetAdvisorSessionContextMock = vi.mocked(resetAdvisorSessionContext);
const setAdvisorCheckinsEnabledMock = vi.mocked(setAdvisorCheckinsEnabled);

function fakeCtx(id = randomUUID(), idle = true) {
  return {
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => `/tmp/pi-rogue-goal-test-${id}.jsonl`,
    },
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
    },
  };
}

describe("goal processing", () => {
  beforeEach(() => {
    resetAdvisorSessionContextMock.mockClear();
    setAdvisorCheckinsEnabledMock.mockClear();
  });

  function countGoalEntries(text: string, goal: string): number {
    return text
      .split("\n")
      .filter((line) => line.includes(goal))
      .length;
  }

  it("starts an immediate standalone goal check when no loop is active", () => {
    const ctx = fakeCtx();
    const sent: Array<{ text: string; options?: unknown }> = [];
    const pi = {
      sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
    } as any;

    expect(setGoal(ctx, "ship a small fix")).toBe("updated");
    const result = startGoalProcessing(pi, ctx, "ship a small fix");

    expect(result).toBe("standalone");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Goal check and work request:");
    expect(sent[0].text).toContain("Current goal: ship a small fix");
    expect(sent[0].text).toContain("Start processing the goal immediately.");
    expect(sent[0].text).toContain("Take the first concrete step now");
    expect(sent[0].text).toContain("Do not only record, restate, or summarize the goal.");
    endGoalCheck(ctx);
  });

  it("does not append history or reset orchestration for an exact active goal duplicate", () => {
    const ctx = fakeCtx();
    const goal = `dedupe goal ${randomUUID()}`;
    const before = readText(featureFile("orchestration", "goal-history.jsonl"));

    expect(setGoal(ctx, goal)).toBe("updated");
    setAdvisorCheckinsEnabledMock.mockClear();
    const afterFirst = readText(featureFile("orchestration", "goal-history.jsonl"));
    expect(setGoal(ctx, goal)).toBe("duplicate");
    const afterSecond = readText(featureFile("orchestration", "goal-history.jsonl"));

    expect(countGoalEntries(before, goal)).toBe(0);
    expect(countGoalEntries(afterFirst, goal)).toBe(1);
    expect(countGoalEntries(afterSecond, goal)).toBe(1);
    expect(resetAdvisorSessionContextMock).toHaveBeenCalledTimes(1);
    expect(setAdvisorCheckinsEnabledMock).toHaveBeenCalledWith(true);
    clearGoal(ctx);
  });

  it("allows explicit goal changes without cycle heuristics", () => {
    const ctx = fakeCtx();
    const first = `cycle-a ${randomUUID()}`;
    const second = `cycle-b ${randomUUID()}`;

    expect(setGoal(ctx, first)).toBe("updated");
    expect(setGoal(ctx, second)).toBe("updated");
    expect(setGoal(ctx, first)).toBe("updated");
    expect(setGoal(ctx, second)).toBe("updated");
    expect(setGoal(ctx, first)).toBe("updated");
    expect(setGoal(ctx, second)).toBe("updated");

    clearGoal(ctx);
    expect(setGoal(ctx, second)).toBe("updated");
    clearGoal(ctx);
  });

  it("queues immediate standalone goal processing as follow-up when busy", () => {
    const ctx = fakeCtx(undefined, false);
    const sent: Array<{ text: string; options?: unknown }> = [];
    const pi = {
      sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
    } as any;

    setGoal(ctx, "finish benchmark report");
    const result = startGoalProcessing(pi, ctx, "finish benchmark report");

    expect(result).toBe("standalone");
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ deliverAs: "followUp" });
    endGoalCheck(ctx);
  });

  it("clears stale no-progress recovery state when goal lifecycle changes", () => {
    const ctx = fakeCtx();
    const guardFile = sessionFile("orchestration", ctx, "repetition-guard.json");
    writeText(guardFile, `${JSON.stringify({
      recentAssistantTurns: [],
      noProgress: { at: new Date().toISOString(), count: 3, text: "I will plan next.", reason: "test" },
    })}\n`);

    setGoal(ctx, "fresh goal after stale recovery");

    expect(JSON.parse(readText(guardFile)).noProgress).toBeUndefined();
    clearGoal(ctx);
  });

  it("resets advisor context when a goal is cleared", () => {
    const ctx = fakeCtx();

    clearGoal(ctx);

    expect(resetAdvisorSessionContextMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms advisor check-ins when a session resumes with an active goal", () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      sendUserMessage: () => undefined,
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "resume heartbeat after compaction");
    setAdvisorCheckinsEnabledMock.mockClear();

    void handlers.session_start?.[0]?.({}, ctx);

    expect(setAdvisorCheckinsEnabledMock).toHaveBeenCalledWith(true);
  });

  it("disables advisor check-ins when orchestration goal clear stops the loop", async () => {
    const pi = { sendUserMessage: () => undefined } as any;
    const ctx = fakeCtx();

    setGoal(ctx, "clear lifecycle test");
    setAdvisorCheckinsEnabledMock.mockClear();
    await handleGoalCommand(pi, "clear", ctx);

    expect(setAdvisorCheckinsEnabledMock).toHaveBeenCalledWith(false);
  });

  it("completes an active goal through the explicit completion signal", () => {
    const ctx = fakeCtx();
    const goal = `complete with tool ${randomUUID()}`;

    setGoal(ctx, goal);
    const result = completeActiveGoal(ctx, {
      summary: "Implemented the requested behavior.",
      verification: "Ran focused unit tests.",
      source: "tool",
    });

    expect(result.completed).toBe(true);
    expect(activeGoal(ctx)).toBe("");
    expect(readText(featureFile("orchestration", "goal-completions.jsonl"))).toContain(goal);
  });

  it("rejects explicit goal completion without verification", () => {
    const ctx = fakeCtx();
    setGoal(ctx, "needs verification");

    const result = completeActiveGoal(ctx, { summary: "Done", verification: "" });

    expect(result.completed).toBe(false);
    expect(activeGoal(ctx)).toBe("needs verification");
    clearGoal(ctx);
  });

  it("registers a goal completion tool", async () => {
    let tool: any;
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (definition: any) => { tool = definition; },
      sendUserMessage: () => undefined,
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "finish explicit tool path");
    const response = await tool.execute("call", {
      summary: "Finished explicit path.",
      verification: "Verified with a fake focused check.",
    }, undefined, undefined, ctx);

    expect(tool.name).toBe("goal_complete");
    expect(response.details.completed).toBe(true);
    expect(activeGoal(ctx)).toBe("");
  });

  it("clears the active goal immediately when a pending check returns GOAL_DONE", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      sendUserMessage: () => undefined,
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "ship the thing");
    startGoalProcessing(pi, ctx, "ship the thing");
    await handlers.agent_end?.[0]?.({
      messages: [{ role: "assistant", content: "GOAL_DONE: shipped with evidence" }],
    }, ctx);

    expect(activeGoal(ctx)).toBe("");
  });

});
