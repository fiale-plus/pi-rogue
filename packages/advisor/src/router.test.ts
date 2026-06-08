import { describe, expect, it } from "vitest";
import { formatAdvisorDisplay, heuristicRoute, routeNote, shouldQueryClassifier, summarizeRoute, type AdvisorRouteInput } from "./router.js";

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
    expect(routeNote(route)).toMatch(/^\[advisor:rules: continue, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("escalates complex architecture work", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "need to refactor the architecture and tradeoffs" };
    const route = heuristicRoute(input);

    expect(route.label).toBe("escalate_to_advisor");
    expect(route.preflight).toBe("full");
    expect(route.review).toBe("light");
    expect(route.escalate).toBe(true);
    expect(summarizeRoute(route)).toContain("preflight:escalate_to_advisor");
    expect(routeNote(route)).toMatch(/^\[advisor:rules: review, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("escalates strategy and decision prompts", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "does it make sense to buy 3x usage 2x higher sustained speed? what would you choose as a strategy" };
    const route = heuristicRoute(input);

    expect(route.label).toBe("escalate_to_advisor");
    expect(route.escalate).toBe(true);
    expect(routeNote(route)).toMatch(/^\[advisor:rules: review, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("flags safety-sensitive prompts", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "run rm -rf on prod" };
    const route = heuristicRoute(input);

    expect(route.safety).toBe(true);
    expect(route.label).toBe("escalate_to_advisor");
    expect(routeNote(route)).toMatch(/^\[advisor:rules: review, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("does not treat historical token mentions as safety escalation", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "We previously had HF token rotation and forgot to update this thread" };
    const route = heuristicRoute(input);

    expect(route.safety).toBe(false);
    expect(route.label).not.toBe("escalate_to_advisor");
  });

  it("reviews incomplete work as not done", () => {
    const input: AdvisorRouteInput = { phase: "review", text: "still incomplete, tests fail", failed: true };
    const route = heuristicRoute(input);

    expect(route.label).toBe("not_done");
    expect(route.review).toBe("strict");
    expect(route.escalate).toBe(true);
    expect(routeNote(route)).toMatch(/^\[advisor:rules: review, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("abstains when review signal is weak", () => {
    const input: AdvisorRouteInput = { phase: "review", text: "looks okay" };
    const route = heuristicRoute(input);

    expect(route.label).toBe("abstain");
    expect(route.review).toBe("off");
    expect(shouldQueryClassifier(route)).toBe(true);
    expect(routeNote(route)).toMatch(/^\[advisor:rules: defer, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("tags model-routed notes explicitly", () => {
    const input: AdvisorRouteInput = { phase: "preflight", text: "what would you choose as a strategy for this decision" };
    const route = { ...heuristicRoute(input), source: "model" as const };

    expect(routeNote(route)).toMatch(/^\[advisor:model: review, reason: [a-z0-9 ,.'-]+\]$/);
  });

  it("formats llm advisor messages with the llm tag", () => {
    expect(formatAdvisorDisplay("advisor:llm", "review", "All set and reviewed")).toBe("[advisor:llm: review, reason: all set and reviewed]");
  });
});
