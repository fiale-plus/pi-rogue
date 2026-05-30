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
    "Goal check and work request:",
    `Current goal: ${goal}`,
    "Are we done? Ignore step/phase details; judge only whether the goal itself is complete.",
    "If done, start your response with `GOAL_DONE: <short reason>` and summarize final state.",
    "If not done, start your response with `GOAL_CONTINUE: <short reason>` and then continue working.",
    "After `GOAL_CONTINUE`, immediately take the next concrete action toward the goal. Do not only record, restate, or summarize the goal.",
    instruction ? `Current loop instruction: ${truncate(instruction, 400)}` : "",
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
