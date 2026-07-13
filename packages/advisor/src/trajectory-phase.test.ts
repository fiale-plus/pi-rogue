import { describe, expect, it } from "vitest";
import { advisorPhaseForRouterPhase, ROUTER_TO_ADVISOR_PHASE, type RouterPhase } from "../../../scripts/trajectory-phase.js";

describe("router to advisor trajectory phase mapping", () => {
  it("maps every router phase explicitly", () => {
    const phases: RouterPhase[] = ["planning", "implementation", "debug", "review", "research", "ops", "unknown"];
    expect(Object.keys(ROUTER_TO_ADVISOR_PHASE).sort()).toEqual([...phases].sort());
    expect(phases.map(advisorPhaseForRouterPhase)).toEqual(["preflight", "review", "review", "closeout", "preflight", "review", undefined]);
  });
});
