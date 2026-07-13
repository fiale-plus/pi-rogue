export type RouterPhase = "planning" | "implementation" | "debug" | "review" | "research" | "ops" | "unknown";
export type AdvisorTrajectoryPhase = "preflight" | "review" | "closeout";

export const ROUTER_TO_ADVISOR_PHASE = {
  planning: "preflight",
  implementation: "review",
  debug: "review",
  review: "closeout",
  research: "preflight",
  ops: "review",
  unknown: undefined,
} as const satisfies Record<RouterPhase, AdvisorTrajectoryPhase | undefined>;

export function advisorPhaseForRouterPhase(phase: RouterPhase): AdvisorTrajectoryPhase | undefined {
  return ROUTER_TO_ADVISOR_PHASE[phase];
}
