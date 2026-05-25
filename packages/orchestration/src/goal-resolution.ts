import { sessionKey, truncate } from "./internal.js";

const goalChecks = new Map<string, boolean>();

export function hasGoalCheckPending(ctx: any): boolean {
  return goalChecks.get(sessionKey(ctx)) === true;
}

export function beginGoalCheck(ctx: any): void {
  goalChecks.set(sessionKey(ctx), true);
}

export function endGoalCheck(ctx: any): void {
  goalChecks.delete(sessionKey(ctx));
}

export function buildGoalCheckPrompt(goal: string, instruction: string): string {
  return [
    "Goal check:",
    `Current goal: ${goal}`,
    "Are we done? Ignore step/phase details; judge only whether the goal itself is complete.",
    "If done, reply exactly with `GOAL_DONE: <short reason>`.",
    "If not done, reply exactly with `GOAL_CONTINUE: <short reason>` and continue working.",
    instruction ? `Current loop instruction: ${truncate(instruction, 200)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function goalCheckResult(text: string): "done" | "continue" | "unknown" {
  const raw = text.trim();
  if (/^GOAL_DONE\b/i.test(raw)) return "done";
  if (/^GOAL_CONTINUE\b/i.test(raw)) return "continue";
  return "unknown";
}
