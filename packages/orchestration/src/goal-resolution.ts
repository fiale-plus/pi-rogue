import { createHash, randomUUID } from "node:crypto";
import { sessionKey, truncate } from "./internal.js";

const GOAL_CHECK_MARKER_VERSION = "v1";
const goalChecks = new Map<string, GoalCheckRequest>();
const goalGenerations = new Map<string, number>();

export type GoalCheckRequest = {
  requestId: string;
  generation: number;
  goalIdentity: string;
  goal: string;
  delivered?: boolean;
};

function goalIdentity(goal: string): string {
  return createHash("sha256").update(`goal-v1:${goal}`, "utf8").digest("hex").slice(0, 16);
}

function generationFor(ctx: any): number {
  return goalGenerations.get(sessionKey(ctx)) ?? 0;
}

function requestMarker(request: GoalCheckRequest): string {
  return `[PI_ROGUE_GOAL_CHECK ${GOAL_CHECK_MARKER_VERSION} request=${request.requestId} generation=${request.generation} goal=${request.goalIdentity}]`;
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function deliveredRequestMatches(event: any, pending: GoalCheckRequest): boolean {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const markers = messages
    .filter((message: any) => message?.role === "user")
    .map((message: any) => userMessageText(message.content).split("\n", 1)[0]?.trim() ?? "")
    .filter((line: string) => line.startsWith("[PI_ROGUE_GOAL_CHECK"));
  const expected = requestMarker(pending);
  return markers.at(-1) === expected && markers.filter((marker: string) => marker === expected).length === 1;
}

export function hasGoalCheckPending(ctx: any): boolean {
  return goalChecks.has(sessionKey(ctx));
}

export function currentDeliveredGoalCheck(ctx: any, activeGoal: string): GoalCheckRequest | undefined {
  const pending = goalChecks.get(sessionKey(ctx));
  if (!pending?.delivered || pending.generation !== generationFor(ctx)) return undefined;
  if (pending.goal !== activeGoal || pending.goalIdentity !== goalIdentity(activeGoal)) return undefined;
  return pending;
}

export function markGoalCheckDelivered(ctx: any, prompt: unknown): GoalCheckRequest | undefined {
  const pending = goalChecks.get(sessionKey(ctx));
  if (!pending || String(prompt ?? "").split("\n", 1)[0]?.trim() !== requestMarker(pending)) return undefined;
  pending.delivered = true;
  return pending;
}

export function beginGoalCheck(ctx: any, goal: string): GoalCheckRequest {
  const request = {
    requestId: randomUUID(),
    generation: generationFor(ctx),
    goalIdentity: goalIdentity(goal),
    goal,
  };
  goalChecks.set(sessionKey(ctx), request);
  return request;
}

export function consumeDeliveredGoalCheck(ctx: any, event: any, activeGoal: string): GoalCheckRequest | undefined {
  const key = sessionKey(ctx);
  const pending = goalChecks.get(key);
  if (!pending || !deliveredRequestMatches(event, pending)) return undefined;

  goalChecks.delete(key);
  if (pending.generation !== generationFor(ctx)) return undefined;
  if (pending.goal !== activeGoal || pending.goalIdentity !== goalIdentity(activeGoal)) return undefined;
  return pending;
}

export function endGoalCheck(ctx: any): void {
  goalChecks.delete(sessionKey(ctx));
}

export function invalidateGoalChecks(ctx: any): void {
  const key = sessionKey(ctx);
  goalChecks.delete(key);
  goalGenerations.set(key, (goalGenerations.get(key) ?? 0) + 1);
}

export function buildGoalCheckPrompt(goal: string, instruction: string, request: GoalCheckRequest): string {
  return [
    requestMarker(request),
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
