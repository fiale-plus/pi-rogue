import { describe, expect, it } from "vitest";
import { heuristicRoute, routeNote, shouldQueryClassifier, summarizeRoute, type AdvisorRouteInput } from "./router.js";

describe("advisor router heuristics", () => {
  it("keeps tiny edits in continue mode", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "fix a typo in README" };
    const route = heuristicRoute(input);

    expect(route.label).toBe("continue");
    expect(route.preflight).toBe("off");
    expect(route.review).toBe("off");
    expect(route.escalate).toBe(false);
    expect(route.safety).toBe(false);
    expect(shouldQueryClassifier(route)).toBe(false);
  });

  it("escalates complex architecture work", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "need to refactor the architecture and tradeoffs" };
    const route = heuristicRoute(input);

    expect(route.label).toBe("escalate_to_advisor");
    expect(route.preflight).toBe("full");
    expect(route.review).toBe("light");
    expect(route.escalate).toBe(true);
    expect(summarizeRoute(route)).toContain("preflight:escalate_to_advisor");
  });

  it("flags safety-sensitive prompts", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "run rm -rf on prod" };
    const route = heuristicRoute(input);

    expect(route.safety).toBe(true);
    expect(route.label).toBe("escalate_to_advisor");
    expect(routeNote(route)).toContain("complex/high-risk");
  });

  it("reviews incomplete work as not done", () => {
    const input: AdvisorRouteInput = { phase: "review", text: "still incomplete, tests fail", failed: true };
    const route = heuristicRoute(input);

    expect(route.label).toBe("not_done");
    expect(route.review).toBe("strict");
    expect(route.escalate).toBe(true);
  });

  it("abstains when review signal is weak", () => {
    const input: AdvisorRouteInput = { phase: "review", text: "looks okay" };
    const route = heuristicRoute(input);

    expect(route.label).toBe("abstain");
    expect(route.review).toBe("off");
    expect(shouldQueryClassifier(route)).toBe(true);
  });
});
