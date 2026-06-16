import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendText, contentText, featureFile, readText, sessionFile, truncate, writeText } from "./internal.js";
import { clearResearchStateForGoal, readResearchState, writeResearchState, type ResearchState } from "./autoresearch-state.js";
import { beginGoalCheck, buildGoalCheckPrompt, endGoalCheck, goalCheckResult, hasGoalCheckPending } from "./goal-resolution.js";
import { clearLoop, triggerLoopTick } from "./loop.js";
import { clearNoProgressRecovery } from "./novelty-guard.js";
import { resetAdvisorSessionContext, setAdvisorCheckinsEnabled } from "./advisor-checkins.js";

const FEATURE = "orchestration";
const CURRENT_FILE = "goal.md";
const HISTORY_FILE = featureFile(FEATURE, "goal-history.jsonl");
const COMPLETION_HISTORY_FILE = featureFile(FEATURE, "goal-completions.jsonl");

type GoalHistoryEntry = {
  at: string;
  goal: string;
};

export type GoalCompletionInput = {
  summary: string;
  verification: string;
  source?: "tool" | "sentinel";
};

export type GoalCompletionResult = {
  completed: boolean;
  goal?: string;
  reason?: string;
};

export type GoalSetResult = "updated" | "duplicate";
export type GoalProcessingStartResult = "loop" | "standalone" | "pending";

export function activeGoal(ctx: any): string {
  return readText(sessionFile(FEATURE, ctx, CURRENT_FILE)).trim();
}

function historyEntries(limit = 10): GoalHistoryEntry[] {
  const raw = readText(HISTORY_FILE).trim();
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as GoalHistoryEntry;
      } catch {
        return { at: new Date().toISOString(), goal: line };
      }
    });
}

export function setGoal(ctx: any, goal: string, options: { restartDuplicate?: boolean } = {}): GoalSetResult {
  const note = goal.trim();
  const previous = activeGoal(ctx);
  if (previous === note && !options.restartDuplicate) {
    if (note) {
      setAdvisorCheckinsEnabled(true);
    }
    return "duplicate";
  }

  if (previous && previous !== note) {
    clearResearchStateForGoal(ctx, previous);
  }
  clearLoop(ctx, { clearResearch: true, preserveCheckins: true });
  clearNoProgressRecovery(ctx);
  writeText(sessionFile(FEATURE, ctx, CURRENT_FILE), note ? `${note}\n` : "");
  resetAdvisorSessionContext(ctx);
  if (note) {
    setAdvisorCheckinsEnabled(true);
  }
  endGoalCheck(ctx);

  if (note) {
    appendText(HISTORY_FILE, `${JSON.stringify({ at: new Date().toISOString(), goal: note })}\n`);
  }
  return "updated";
}

export function clearGoal(ctx: any): void {
  writeText(sessionFile(FEATURE, ctx, CURRENT_FILE), "");
  clearNoProgressRecovery(ctx);
  resetAdvisorSessionContext(ctx);
}

function completionLine(goal: string, input: GoalCompletionInput): string {
  return `${JSON.stringify({
    at: new Date().toISOString(),
    goal,
    summary: input.summary.trim(),
    verification: input.verification.trim(),
    source: input.source ?? "tool",
  })}\n`;
}

export function completeActiveGoal(ctx: any, input: GoalCompletionInput): GoalCompletionResult {
  const goal = activeGoal(ctx);
  if (!goal) return { completed: false, reason: "No active goal." };

  const summary = input.summary.trim();
  const verification = input.verification.trim();
  if (!summary) return { completed: false, goal, reason: "Goal completion requires a summary." };
  if (!verification) return { completed: false, goal, reason: "Goal completion requires verification evidence or an explicit not-verified statement." };

  appendText(COMPLETION_HISTORY_FILE, completionLine(goal, { ...input, summary, verification }));

  const research = researchForGoal(ctx, goal);
  if (research) recordResearchResult(ctx, research, "done");

  endGoalCheck(ctx);
  clearGoal(ctx);
  setGoalStatus(ctx, null);
  clearLoop(ctx, { clearResearch: true });
  return { completed: true, goal };
}

function goalBlock(goal: string): string {
  return [
    "## Pi-Rogue Goal",
    `Current goal: ${goal}`,
    "When the goal is complete, prefer the `goal_complete` tool with a summary and verification evidence. If that tool is unavailable during a loop tick, answer exactly with `GOAL_DONE: ...`.",
    "When the goal is not complete during a loop tick, answer exactly with `GOAL_CONTINUE: ...` and then take one concrete next action.",
  ].join("\n");
}

export function setGoalStatus(ctx: any, goal: string | null): void {
  ctx.ui.setStatus("orchestration-goal", goal ? `🎯 ${truncate(goal, 60)}` : undefined);
}

function assistantText(event: any): string {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
  return contentText(lastAssistant?.content);
}

function researchForGoal(ctx: any, goal: string): ResearchState | null {
  const state = readResearchState(ctx);
  if (!state.instruction || !state.goal || state.goal !== goal) return null;
  return state;
}

function recordResearchResult(ctx: any, state: ResearchState, result: "done" | "continue" | "unknown"): void {
  writeResearchState(ctx, {
    ...state,
    cycles: (state.cycles ?? 0) + 1,
    lastResult: result,
  });
}

export function startGoalProcessing(pi: ExtensionAPI, ctx: any, goal: string): GoalProcessingStartResult {
  if (hasGoalCheckPending(ctx)) {
    return "pending";
  }

  if (triggerLoopTick(pi, ctx)) {
    return "loop";
  }

  beginGoalCheck(ctx);
  const prompt = buildGoalCheckPrompt(
    goal,
    "Start processing the goal immediately. Take the first concrete step now: inspect, run, edit, or ask only if a specific blocker prevents action.",
  );
  if (ctx.isIdle?.() === false) {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  } else {
    pi.sendUserMessage(prompt);
  }
  return "standalone";
}

export function registerGoal(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueGoalRegistered) return;
  p.__piRogueGoalRegistered = true;

  pi.on("session_start", (_event, ctx) => {
    endGoalCheck(ctx);
    const goal = activeGoal(ctx);
    setGoalStatus(ctx, goal || null);
    if (goal) {
      setAdvisorCheckinsEnabled(true);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    endGoalCheck(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const goal = activeGoal(ctx);
    if (!goal || !hasGoalCheckPending(ctx)) return;

    const result = goalCheckResult(assistantText(event));
    endGoalCheck(ctx);

    const research = researchForGoal(ctx, goal);
    if (research) recordResearchResult(ctx, research, result);

    if (result === "done") {
      const text = assistantText(event);
      const summary = text.replace(/^GOAL_DONE:\s*/i, "").trim() || "Goal marked done by sentinel response.";
      completeActiveGoal(ctx, {
        summary: truncate(summary, 1200),
        verification: "GOAL_DONE sentinel response; see assistant message for final state and evidence.",
        source: "sentinel",
      });
      ctx.ui.notify(`🎯 Goal completed: ${truncate(goal, 160)}`, "info");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const goal = activeGoal(ctx);
    setGoalStatus(ctx, goal || null);
    if (!goal) return { systemPrompt: event.systemPrompt };

    return { systemPrompt: `${event.systemPrompt}\n\n${goalBlock(goal)}` };
  });

  const registerTool = (pi as any).registerTool;
  if (typeof registerTool === "function") registerTool.call(pi, {
    name: "goal_complete",
    label: "Goal Complete",
    description: "Mark the active Pi-Rogue goal complete. Requires a completion summary and verification evidence.",
    parameters: Type.Object({
      summary: Type.String({ description: "What was completed for the active goal" }),
      verification: Type.String({ description: "How completion was verified, or an explicit not-verified statement with reason" }),
    }),
    async execute(_id: unknown, params: { summary?: unknown; verification?: unknown }, _signal: unknown, onUpdate: ((update: unknown) => void) | undefined, ctx: any) {
      const result = completeActiveGoal(ctx, {
        summary: String(params.summary ?? ""),
        verification: String(params.verification ?? ""),
        source: "tool",
      });
      if (!result.completed) {
        const message = result.reason || "Goal completion failed.";
        onUpdate?.({ content: [{ type: "text", text: message }], details: { completed: false } });
        return { content: [{ type: "text", text: message }], details: { completed: false } };
      }

      const message = `Goal completed: ${truncate(result.goal || "", 160)}`;
      ctx.ui.notify(`🎯 ${message}`, "info");
      return { content: [{ type: "text", text: message }], details: { completed: true, goal: result.goal } };
    },
  });

}

export async function handleGoalCommand(pi: ExtensionAPI, args: unknown, ctx: any): Promise<void> {
  const input = String(args ?? "").trim();
  const [cmd, ...rest] = input.split(/\s+/);
  const known = new Set(["set", "show", "clear", "list"]);
  const resolved = !input ? "show" : known.has(cmd) ? cmd : "set";
  const text = resolved === "set" && known.has(cmd) ? rest.join(" ").trim() : input;

  if (resolved === "show") {
    const goal = activeGoal(ctx);
    setGoalStatus(ctx, goal || null);
    ctx.ui.notify(goal ? `🎯 ${truncate(goal, 160)}` : "No active goal.", "info");
    return;
  }

  if (resolved === "clear") {
    const goal = activeGoal(ctx);
    const clearedResearch = goal ? clearResearchStateForGoal(ctx, goal) : false;
    clearGoal(ctx);
    endGoalCheck(ctx);
    setGoalStatus(ctx, null);
    clearLoop(ctx, { clearResearch: true });
    ctx.ui.notify(goal ? `Goal cleared${clearedResearch ? "; matching autoresearch status cleared" : ""}.` : "No goal to clear.", "info");
    return;
  }

  if (resolved === "list") {
    const entries = historyEntries();
    if (entries.length === 0) {
      ctx.ui.notify("No goal history yet.", "info");
      return;
    }

    ctx.ui.notify(
      entries
        .map((entry, index) => `${index + 1}. ${truncate(entry.goal, 120)} (${new Date(entry.at).toLocaleDateString()})`)
        .join("\n"),
      "info",
    );
    return;
  }

  if (!text) {
    ctx.ui.notify("Usage: /pi-rogue-orchestration goal set <text>", "error");
    return;
  }

  const result = setGoal(ctx, text);
  if (result === "duplicate") {
    ctx.ui.notify(`🎯 Goal already active: ${truncate(text, 160)}.`, "info");
    return;
  }

  setGoalStatus(ctx, text);
  const started = startGoalProcessing(pi, ctx, text);
  ctx.ui.notify(`🎯 Goal set: ${truncate(text, 160)}${started === "pending" ? " (goal processing already pending)" : " — processing started"}`, "info");
}
