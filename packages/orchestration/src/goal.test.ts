import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAdvisorSessionContext } from "./advisor-checkins.js";
import { endGoalCheck } from "./goal-resolution.js";
import { clearGoal, setGoal, startGoalProcessing } from "./goal.js";
import { recordBudgetTurn } from "./budget.js";

vi.mock("./advisor-checkins.js", () => ({
  resetAdvisorSessionContext: vi.fn(),
  setAdvisorCheckinsEnabled: vi.fn(),
}));

const resetAdvisorSessionContextMock = vi.mocked(resetAdvisorSessionContext);

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
  });

  it("starts an immediate standalone goal check when no loop is active", () => {
    const ctx = fakeCtx();
    const sent: Array<{ text: string; options?: unknown }> = [];
    const pi = {
      sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
    } as any;

    setGoal(ctx, "ship a small fix");
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

  it("resets advisor context when a goal is cleared", () => {
    const ctx = fakeCtx();

    clearGoal(ctx);

    expect(resetAdvisorSessionContextMock).toHaveBeenCalledTimes(1);
  });

  it("stops goal processing when the flow budget is exhausted", () => {
    const ctx = fakeCtx();
    const sent: Array<{ text: string; options?: unknown }> = [];
    const pi = {
      sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
    } as any;

    setGoal(ctx, "ship a small fix");
    for (let i = 0; i < 20; i++) {
      recordBudgetTurn(ctx);
    }

    const result = startGoalProcessing(pi, ctx, "ship a small fix");

    expect(result).toBe("budget_exhausted");
    expect(sent).toHaveLength(0);
    endGoalCheck(ctx);
  });
});
