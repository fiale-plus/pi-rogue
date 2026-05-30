import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endGoalCheck } from "./goal-resolution.js";
import { setGoal, startGoalProcessing } from "./goal.js";

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
});
