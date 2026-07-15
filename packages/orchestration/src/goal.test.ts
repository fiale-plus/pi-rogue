import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAdvisorSessionContext, setAdvisorCheckinDemand } from "./advisor-checkins.js";
import { endGoalCheck, GOAL_CHECK_DELIVERY_LEASE_MS, hasGoalCheckPending } from "./goal-resolution.js";
import { activeGoal, clearGoal, completeActiveGoal, handleGoalCommand, registerGoal, setGoal, startGoalProcessing } from "./goal.js";
import { featureFile, readText, sessionFile, writeText } from "./internal.js";
import { readResearchState, writeResearchState } from "./autoresearch-state.js";

vi.mock("./advisor-checkins.js", () => ({
  resetAdvisorSessionContext: vi.fn(),
  setAdvisorCheckinDemand: vi.fn(),
}));

const resetAdvisorSessionContextMock = vi.mocked(resetAdvisorSessionContext);
const setAdvisorCheckinDemandMock = vi.mocked(setAdvisorCheckinDemand);

function seedResearch(ctx: any, goal: string, cycles = 0, evidenceCycles = cycles): void {
  writeResearchState(ctx, {
    kind: "autoresearch",
    instruction: "improve benchmark",
    goal,
    loopInstruction: "run one measured cycle",
    interval: "5m",
    cycles,
    evidenceCycles,
    recordedCycleIds: Array.from({ length: cycles }, (_, index) => `seed-${index}`),
    updatedAt: "",
  });
}

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
    setAdvisorCheckinDemandMock.mockClear();
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

  it("rolls back a pending goal check when immediate enqueue fails", () => {
    const ctx = fakeCtx();
    const sent: string[] = [];
    let attempts = 0;
    const pi = {
      sendUserMessage: (text: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient enqueue failure");
        sent.push(text);
      },
    } as any;

    expect(() => startGoalProcessing(pi, ctx, "retry delivery")).toThrow("transient enqueue failure");
    expect(hasGoalCheckPending(ctx)).toBe(false);
    expect(startGoalProcessing(pi, ctx, "retry delivery")).toBe("standalone");
    expect(hasGoalCheckPending(ctx)).toBe(true);
    expect(sent).toHaveLength(1);
    endGoalCheck(ctx);
  });

  it("expires an undelivered request when the host hides an async enqueue rejection", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = fakeCtx();
    let attempts = 0;
    const pi = {
      sendUserMessage: () => {
        attempts += 1;
        void Promise.reject(new Error("hidden async enqueue failure")).catch(() => undefined);
      },
    } as any;

    expect(startGoalProcessing(pi, ctx, "retry hidden failure")).toBe("standalone");
    expect(hasGoalCheckPending(ctx)).toBe(true);
    vi.setSystemTime(Date.now() + GOAL_CHECK_DELIVERY_LEASE_MS);
    expect(hasGoalCheckPending(ctx)).toBe(false);
    expect(startGoalProcessing(pi, ctx, "retry hidden failure")).toBe("standalone");
    expect(attempts).toBe(2);
    endGoalCheck(ctx);
    vi.useRealTimers();
  });

  it("does not expire a successfully queued follow-up during a long-running turn", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = { ...fakeCtx(undefined, false), hasPendingMessages: () => true };
    const sent: Array<{ options?: { deliverAs?: string } }> = [];
    const pi = { sendUserMessage: (_text: string, options?: { deliverAs?: string }) => sent.push({ options }) } as any;

    expect(startGoalProcessing(pi, ctx, "long queued goal")).toBe("standalone");
    expect(sent[0]?.options?.deliverAs).toBe("followUp");
    vi.setSystemTime(Date.now() + GOAL_CHECK_DELIVERY_LEASE_MS * 2);
    expect(hasGoalCheckPending(ctx)).toBe(true);
    endGoalCheck(ctx);
    vi.useRealTimers();
  });

  it("expires a failed follow-up when the host queue has no pending message", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = { ...fakeCtx(undefined, false), hasPendingMessages: () => false };
    const pi = {
      sendUserMessage: () => {
        void Promise.reject(new Error("hidden follow-up failure")).catch(() => undefined);
      },
    } as any;

    expect(startGoalProcessing(pi, ctx, "failed queued goal")).toBe("standalone");
    vi.setSystemTime(Date.now() + GOAL_CHECK_DELIVERY_LEASE_MS);
    expect(hasGoalCheckPending(ctx)).toBe(false);
    vi.useRealTimers();
  });

  it("does not append history or reset orchestration for an exact active goal duplicate", () => {
    const ctx = fakeCtx();
    const goal = `dedupe goal ${randomUUID()}`;
    const before = readText(featureFile("orchestration", "goal-history.jsonl"));

    expect(setGoal(ctx, goal)).toBe("updated");
    setAdvisorCheckinDemandMock.mockClear();
    const afterFirst = readText(featureFile("orchestration", "goal-history.jsonl"));
    expect(setGoal(ctx, goal)).toBe("duplicate");
    const afterSecond = readText(featureFile("orchestration", "goal-history.jsonl"));

    expect(countGoalEntries(before, goal)).toBe(0);
    expect(countGoalEntries(afterFirst, goal)).toBe(1);
    expect(countGoalEntries(afterSecond, goal)).toBe(1);
    expect(resetAdvisorSessionContextMock).toHaveBeenCalledTimes(1);
    expect(setAdvisorCheckinDemandMock).toHaveBeenCalledWith(ctx, "goal", true);
    clearGoal(ctx);
  });

  it("shows the active goal and next commands when /goal is invoked while active", async () => {
    const pi = { sendUserMessage: () => undefined } as any;
    const ctx = fakeCtx();
    const notify = vi.fn();
    ctx.ui.notify = notify;

    setGoal(ctx, "write normal-language feedback");
    await handleGoalCommand(pi, "", ctx);

    expect(notify).toHaveBeenCalledWith(
      "A goal is already active: write normal-language feedback\nUse `/goal show` to see it, `/goal clear` to stop it, or `/goal set ...` to replace it.",
      "info",
    );
    expect(activeGoal(ctx)).toBe("write normal-language feedback");
    clearGoal(ctx);
  });

  it("treats goal status as a read-only show alias", async () => {
    const pi = { sendUserMessage: vi.fn() } as any;
    const ctx = fakeCtx();
    const notify = vi.fn();
    ctx.ui.notify = notify;

    const goal = `preserve status goal ${randomUUID()}`;
    setGoal(ctx, goal);
    const goalBefore = activeGoal(ctx);
    const historyCountBefore = countGoalEntries(readText(featureFile("orchestration", "goal-history.jsonl")), goal);
    const loopBefore = readText(sessionFile("orchestration", ctx, "loop.json"));
    const researchBefore = readText(sessionFile("orchestration", ctx, "autoresearch.json"));

    await handleGoalCommand(pi, "status", ctx);

    expect(notify).toHaveBeenCalledWith(
      `A goal is already active: ${goal}\nUse \`/goal show\` to see it, \`/goal clear\` to stop it, or \`/goal set ...\` to replace it.`,
      "info",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(activeGoal(ctx)).toBe(goalBefore);
    expect(countGoalEntries(readText(featureFile("orchestration", "goal-history.jsonl")), goal)).toBe(historyCountBefore);
    expect(readText(sessionFile("orchestration", ctx, "loop.json"))).toBe(loopBefore);
    expect(readText(sessionFile("orchestration", ctx, "autoresearch.json"))).toBe(researchBefore);
    clearGoal(ctx);
  });

  it("shows next commands instead of restarting an exact duplicate goal", async () => {
    const pi = { sendUserMessage: vi.fn() } as any;
    const ctx = fakeCtx();
    const notify = vi.fn();
    ctx.ui.notify = notify;

    setGoal(ctx, "keep the active goal");
    await handleGoalCommand(pi, "set keep the active goal", ctx);

    expect(notify).toHaveBeenCalledWith(
      "A goal is already active: keep the active goal\nUse `/goal show` to see it, `/goal clear` to stop it, or `/goal set ...` to replace it.",
      "info",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(activeGoal(ctx)).toBe("keep the active goal");
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
    setAdvisorCheckinDemandMock.mockClear();

    void handlers.session_start?.[0]?.({}, ctx);

    expect(setAdvisorCheckinDemandMock).toHaveBeenCalledWith(ctx, "goal", true);
  });

  it("disables advisor check-ins when orchestration goal clear stops the loop", async () => {
    const pi = { sendUserMessage: () => undefined } as any;
    const ctx = fakeCtx();

    setGoal(ctx, "clear lifecycle test");
    setAdvisorCheckinDemandMock.mockClear();
    await handleGoalCommand(pi, "clear", ctx);

    expect(setAdvisorCheckinDemandMock).toHaveBeenCalledWith(ctx, "goal", false);
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

  it("holds goal_complete open until two independently delivered research cycles exist", async () => {
    let tool: any;
    const sent: string[] = [];
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      registerTool: (definition: any) => { tool = definition; },
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();
    const goal = `research tool gate ${randomUUID()}`;
    registerGoal(pi);
    setGoal(ctx, goal);
    seedResearch(ctx, goal);
    startGoalProcessing(pi, ctx, goal);
    const undelivered = await tool.execute("undelivered", { summary: "Candidate implemented.", verification: "npm test passed 42 tests." }, undefined, undefined, ctx);
    expect(undelivered.details.completed).toBe(false);
    expect(readResearchState(ctx)).toMatchObject({ cycles: 0, evidenceCycles: 0 });
    await handlers.message_start?.[0]?.({ message: { role: "user", content: sent.at(-1) } }, ctx);

    const first = await tool.execute("first", { summary: "Candidate implemented.", verification: "npm test passed 42 tests." }, undefined, undefined, ctx);
    expect(first.details.completed).toBe(false);
    expect(first.content[0].text).toMatch(/at least 2 distinct cycles/);
    expect(activeGoal(ctx)).toBe(goal);
    expect(readResearchState(ctx)).toMatchObject({ cycles: 1, evidenceCycles: 1 });
    const repeatedSameCycle = await tool.execute("first-repeat", { summary: "Candidate implemented.", verification: "npm test passed 42 tests." }, undefined, undefined, ctx);
    expect(repeatedSameCycle.details.completed).toBe(false);
    expect(readResearchState(ctx)).toMatchObject({ cycles: 1, evidenceCycles: 1 });

    endGoalCheck(ctx);
    startGoalProcessing(pi, ctx, goal);
    await handlers.message_start?.[0]?.({ message: { role: "user", content: sent.at(-1) } }, ctx);
    const noEvidence = await tool.execute("second", { summary: "Added evaluation result handling.", verification: "Not verified: tests were not run." }, undefined, undefined, ctx);
    expect(noEvidence.details.completed).toBe(false);
    expect(noEvidence.content[0].text).toMatch(/evidence-backed results from at least 2 distinct cycles/);
    expect(readResearchState(ctx)).toMatchObject({ cycles: 2, evidenceCycles: 1 });

    endGoalCheck(ctx);
    startGoalProcessing(pi, ctx, goal);
    await handlers.message_start?.[0]?.({ message: { role: "user", content: sent.at(-1) } }, ctx);
    const second = await tool.execute("third", { summary: "Candidate implemented.", verification: "npm test passed 42 tests." }, undefined, undefined, ctx);
    expect(second.details.completed).toBe(true);
    expect(activeGoal(ctx)).toBe("");
  });

  it("holds first-cycle GOAL_DONE open and accepts evidence on the second delivered cycle", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const sent: string[] = [];
    const notify = vi.fn();
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      registerTool: () => undefined,
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();
    ctx.ui.notify = notify;
    const goal = `research sentinel gate ${randomUUID()}`;
    registerGoal(pi);
    setGoal(ctx, goal);
    seedResearch(ctx, goal);

    startGoalProcessing(pi, ctx, goal);
    await handlers.agent_end?.[0]?.({ messages: [{ role: "user", content: sent[0] }, { role: "assistant", content: "GOAL_DONE: npm run check passed and 42 tests passed" }] }, ctx);
    expect(activeGoal(ctx)).toBe(goal);
    expect(readResearchState(ctx).cycles).toBe(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Autoresearch continuing:.*at least 2 distinct cycles/), "info");

    startGoalProcessing(pi, ctx, goal);
    await handlers.agent_end?.[0]?.({ messages: [{ role: "user", content: sent[1] }, { role: "assistant", content: [{ type: "text", text: "GOAL_DONE: npm run check passed and 42 tests passed" }, { type: "text", text: "benchmark unavailable" }] }] }, ctx);
    expect(activeGoal(ctx)).toBe("");
    const completion = readText(featureFile("orchestration", "goal-completions.jsonl"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.goal === goal);
    expect(completion.verification).toContain("npm run check passed and 42 tests passed\nbenchmark unavailable");
    expect(completion.verification).not.toContain("see assistant message");
  });

  it("clears the active goal only when its delivered check returns GOAL_DONE", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const sent: string[] = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "ship the thing");
    startGoalProcessing(pi, ctx, "ship the thing");
    await handlers.agent_end?.[0]?.({
      messages: [
        { role: "user", content: [{ type: "text", text: sent[0] }] },
        { role: "user", content: [{ type: "text", text: "Also include the final verification detail." }] },
        { role: "assistant", content: [{ type: "text", text: "GOAL_DONE: shipped with evidence" }] },
      ],
    }, ctx);

    expect(activeGoal(ctx)).toBe("");
  });

  it("fails closed when a malformed goal marker follows the delivered request", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const sent: string[] = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "goal with malformed follow-up");
    startGoalProcessing(pi, ctx, "goal with malformed follow-up");
    await handlers.agent_end?.[0]?.({
      messages: [
        { role: "user", content: sent[0] },
        { role: "user", content: "[PI_ROGUE_GOAL_CHECK malformed]" },
        { role: "assistant", content: "GOAL_DONE: should not be accepted" },
      ],
    }, ctx);

    expect(activeGoal(ctx)).toBe("goal with malformed follow-up");
    expect(hasGoalCheckPending(ctx)).toBe(true);
    clearGoal(ctx);
  });

  it("ignores old-A completion after replacing A with B", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const sent: string[] = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "goal A");
    startGoalProcessing(pi, ctx, "goal A");
    const oldPrompt = sent[0];
    setGoal(ctx, "goal B");
    startGoalProcessing(pi, ctx, "goal B");

    await handlers.agent_end?.[0]?.({
      messages: [
        { role: "user", content: oldPrompt },
        { role: "assistant", content: "GOAL_DONE: stale A result" },
      ],
    }, ctx);

    expect(activeGoal(ctx)).toBe("goal B");
    expect(hasGoalCheckPending(ctx)).toBe(true);
    clearGoal(ctx);
  });

  it("ignores old-A completion after clearing A without restarting work", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void> | void>> = {};
    const sent: string[] = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      },
      registerCommand: () => undefined,
      sendUserMessage: (text: string) => sent.push(text),
    } as any;
    const ctx = fakeCtx();

    registerGoal(pi);
    setGoal(ctx, "goal A");
    startGoalProcessing(pi, ctx, "goal A");
    const oldPrompt = sent[0];
    clearGoal(ctx);

    await handlers.agent_end?.[0]?.({
      messages: [
        { role: "user", content: oldPrompt },
        { role: "assistant", content: "GOAL_DONE: stale A result" },
      ],
    }, ctx);

    expect(activeGoal(ctx)).toBe("");
    expect(hasGoalCheckPending(ctx)).toBe(false);
    expect(sent).toHaveLength(1);
  });

});
