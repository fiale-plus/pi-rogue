import { describe, expect, it } from "vitest";
import { formatResearchState, type ResearchState } from "./autoresearch-state.js";

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
});
