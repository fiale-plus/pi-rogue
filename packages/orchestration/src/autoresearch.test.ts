import { beforeEach, describe, expect, it } from "vitest";
import { buildResearchGoal, buildResearchLoopInstruction } from "./autoresearch.js";
import { formatResearchState, type ResearchState } from "./autoresearch-state.js";

describe("autoresearch status", () => {
  beforeEach(() => {
    delete process.env.PI_ROGUE_AUTORESEARCH_MIN_CYCLES;
  });

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
    expect(goal).toContain("at least 2 loop cycles");
  });

  it("respects configured minimum cycles in the generated goal", () => {
    process.env.PI_ROGUE_AUTORESEARCH_MIN_CYCLES = "4";
    const goal = buildResearchGoal("autoresearch", "improve model routing");

    expect(goal).toContain("at least 4 loop cycles");
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
});
