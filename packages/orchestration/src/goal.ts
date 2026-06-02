import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendText, contentText, featureFile, readText, sessionFile, truncate, writeText } from "./internal.js";
import { shouldHoldResearchOpen, type ResearchCheckResult } from "./autoresearch-completion.js";
import { clearResearchStateForGoal, readResearchState, writeResearchState, type ResearchState } from "./autoresearch-state.js";
import { beginGoalCheck, buildGoalCheckPrompt, endGoalCheck, goalCheckResult, hasGoalCheckPending } from "./goal-resolution.js";
import { clearLoop, triggerLoopTick } from "./loop.js";
import { resetAdvisorSessionContext } from "./advisor-checkins.js";
import { goalArgumentCompletions } from "./completions.js";
import { budgetFlowReason, budgetStatus, clearBudgetState, initializeBudgetState, recordBudgetTurn, readBudgetState } from "./budget.js";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const CURRENT_FILE = "goal.md";
const CYCLE_FILE = "goal-cycle.json";
const HISTORY_FILE = featureFile(FEATURE, "goal-history.jsonl");

type GoalHistoryEntry = {
  at: string;
  goal: string;
};

export type GoalSetResult = "updated" | "duplicate" | "cycle";

type GoalCycleState = {
  recentGoals: GoalHistoryEntry[];
  clearedAt?: string;
};

export function activeGoal(ctx: any): string {
  return readText(sessionFile(FEATURE, ctx, CURRENT_FILE)).trim();
}

function parseGoalHistoryEntries(limit: number): GoalHistoryEntry[] {
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

function normalizedGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim();
}

function defaultGoalCycleState(): GoalCycleState {
  return { recentGoals: [] };
}

function readGoalCycleState(ctx: any): GoalCycleState {
  const parsed = readSessionJson<Partial<GoalCycleState>>(FEATURE, ctx, CYCLE_FILE, defaultGoalCycleState());
  return {
    recentGoals: Array.isArray(parsed.recentGoals)
      ? parsed.recentGoals
          .filter((entry) => typeof entry?.goal === "string")
          .map((entry) => ({ at: String(entry.at ?? new Date().toISOString()), goal: entry.goal }))
          .slice(-8)
      : [],
    clearedAt: typeof parsed.clearedAt === "string" ? parsed.clearedAt : undefined,
  };
}

function writeGoalCycleState(ctx: any, state: GoalCycleState): void {
  writeSessionJson(FEATURE, ctx, CYCLE_FILE, {
    ...state,
    recentGoals: state.recentGoals.slice(-8),
  });
}

function recordGoalCycleEntry(ctx: any, goal: string, at: string): void {
  const state = readGoalCycleState(ctx);
  writeGoalCycleState(ctx, {
    recentGoals: [...state.recentGoals, { at, goal }].slice(-8),
    clearedAt: state.clearedAt,
  });
}

function resetGoalCycleState(ctx: any): void {
  writeGoalCycleState(ctx, { recentGoals: [], clearedAt: new Date().toISOString() });
}

function isAlternatingGoalCycle(goals: string[], minTurns = 6): boolean {
  if (goals.length < minTurns) return false;
  const tail = goals.slice(-minTurns).map(normalizedGoal);
  if (!tail[0] || !tail[1] || tail[0] === tail[1]) return false;

  for (let index = 2; index < tail.length; index++) {
    if (tail[index] !== tail[index - 2]) return false;
  }

  return true;
}

function continuesRecentGoalCycle(ctx: any, candidate: string): boolean {
  const recent = readGoalCycleState(ctx).recentGoals.map((entry) => entry.goal);
  return isAlternatingGoalCycle([...recent, candidate]);
}

export function setGoal(ctx: any, goal: string, options: { restartDuplicate?: boolean } = {}): GoalSetResult {
  const note = goal.trim();
  const previous = activeGoal(ctx);
  if (previous === note && !options.restartDuplicate) {
    return "duplicate";
  }
  if (previous !== note && continuesRecentGoalCycle(ctx, note)) {
    return "cycle";
  }

  if (previous && previous !== note) {
    clearResearchStateForGoal(ctx, previous);
  }
  clearLoop(ctx, { clearResearch: true, preserveCheckins: true });
  writeText(sessionFile(FEATURE, ctx, CURRENT_FILE), `${note}\n`);
  initializeBudgetState(ctx, "goal");
  resetAdvisorSessionContext();
  endGoalCheck(ctx);
  const at = new Date().toISOString();
  appendText(HISTORY_FILE, `${JSON.stringify({ at, goal: note })}\n`);
  recordGoalCycleEntry(ctx, note, at);
  return "updated";
}

export function clearGoal(ctx: any): void {
  writeText(sessionFile(FEATURE, ctx, CURRENT_FILE), "");
  resetGoalCycleState(ctx);
  clearBudgetState(ctx);
  resetAdvisorSessionContext();
}

function goalBlock(goal: string): string {
  return [
    "## Pi-Rogue Goal",
    `Current goal: ${goal}`,
    "When a loop tick asks whether the goal is done, answer exactly with `GOAL_DONE: ...` or `GOAL_CONTINUE: ...`.",
  ].join("\n");
}

export function setGoalStatus(ctx: any, goal: string | null): void {
  ctx.ui.setStatus("orchestration-goal", goal ? `🎯 ${truncate(goal, 60)}` : undefined);
}

function historyEntries(): GoalHistoryEntry[] {
  return parseGoalHistoryEntries(10);
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

export type GoalProcessingStartResult = "loop" | "standalone" | "pending" | "budget_exhausted";

export function startGoalProcessing(pi: ExtensionAPI, ctx: any, goal: string): GoalProcessingStartResult {
  if (hasGoalCheckPending(ctx)) {
    return "pending";
  }

  const budgetReason = budgetFlowReason(readBudgetState(ctx));
  if (budgetReason) {
    clearGoal(ctx);
    setGoalStatus(ctx, null);
    clearLoop(ctx, { clearResearch: true });
    ctx.ui.notify(`🧭 Goal budget exhausted: ${budgetReason}.`, "warning");
    return "budget_exhausted";
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

export function recordResearchCheck(ctx: any, state: ResearchState, result: ResearchCheckResult): ResearchState {
  const cycles = (state.cycles ?? 0) + 1;
  const doneAttempts = (state.doneAttempts ?? 0) + (result === "done" ? 1 : 0);
  const next: ResearchState = {
    ...state,
    cycles,
    doneAttempts,
    lastResult: result,
  };
  writeResearchState(ctx, next);
  return next;
}

export function registerGoal(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueGoalRegistered) return;
  p.__piRogueGoalRegistered = true;

  pi.on("session_start", (_event, ctx) => {
    endGoalCheck(ctx);
    const goal = activeGoal(ctx);
    setGoalStatus(ctx, goal || null);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    endGoalCheck(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const goal = activeGoal(ctx);
    if (!goal || !hasGoalCheckPending(ctx)) {
      return;
    }

    const text = assistantText(event);
    const result = goalCheckResult(text);
    endGoalCheck(ctx);

    const research = researchForGoal(ctx, goal);
    const recordedResearch = research ? recordResearchCheck(ctx, research, result) : null;
    const holdReason = recordedResearch ? shouldHoldResearchOpen(recordedResearch, result, text) : null;
    const budget = recordBudgetTurn(ctx);
    const budgetReason = budgetFlowReason(budget);

    if (result === "done" && !holdReason) {
      clearGoal(ctx);
      setGoalStatus(ctx, null);
      clearLoop(ctx, { clearResearch: true });
      ctx.ui.notify(`🎯 Goal completed: ${truncate(goal, 160)}`, "info");
      return;
    }

    if (budgetReason) {
      clearGoal(ctx);
      setGoalStatus(ctx, null);
      clearLoop(ctx, { clearResearch: true });
      ctx.ui.notify(`🧭 Goal budget exhausted: ${budgetReason}.`, "warning");
      return;
    }

    if (holdReason) {
      ctx.ui.notify(`🔎 Autoresearch continuing: ${holdReason}.`, "info");
      return;
    }

    if (result !== "done") {
      return;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const goal = activeGoal(ctx);
    setGoalStatus(ctx, goal || null);
    if (!goal) {
      return { systemPrompt: event.systemPrompt };
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${goalBlock(goal)}` };
  });

  pi.registerCommand("goal", {
    description: "Set, show, clear, or list the current session goal",
    getArgumentCompletions: (prefix: string) => goalArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, ...rest] = input.split(/\s+/);
      const known = new Set(["set", "show", "clear", "list"]);
      const resolved = !input ? "show" : known.has(cmd) ? cmd : "set";
      const text = resolved === "set" && known.has(cmd) ? rest.join(" ").trim() : input;

      if (resolved === "show") {
        const goal = activeGoal(ctx);
        setGoalStatus(ctx, goal || null);
        ctx.ui.notify(goal ? `🎯 ${truncate(goal, 160)} — ${budgetStatus(readBudgetState(ctx))}` : "No active goal.", "info");
        return;
      }

      if (resolved === "clear") {
        const goal = activeGoal(ctx);
        const clearedResearch = goal ? clearResearchStateForGoal(ctx, goal) : false;
        clearGoal(ctx);
        endGoalCheck(ctx);
        setGoalStatus(ctx, null);
        clearLoop(ctx, { clearResearch: true, preserveCheckins: true });
        ctx.ui.notify(goal ? `Goal cleared${clearedResearch ? "; matching autoresearch status cleared" : ""}.` : "No goal to clear.", "info");
        return;
      }

      if (resolved === "list") {
        const entries = historyEntries();
        if (entries.length === 0) {
          ctx.ui.notify("No goal history yet.", "info");
          return;
        }

        const text = entries
          .map((entry, index) => `${index + 1}. ${truncate(entry.goal, 120)} (${new Date(entry.at).toLocaleDateString()})`)
          .join("\n");
        ctx.ui.notify(text, "info");
        return;
      }

      if (!text) {
        ctx.ui.notify("Usage: /goal set <text>", "error");
        return;
      }

      const result = setGoal(ctx, text);
      if (result === "duplicate") {
        ctx.ui.notify(`🎯 Goal already active: ${truncate(text, 160)}. No duplicate goal cycle queued.`, "info");
        return;
      }
      if (result === "cycle") {
        ctx.ui.notify("🎯 Goal not changed: detected a repeating two-goal cycle. Use /goal clear before intentionally restarting this pattern.", "warning");
        return;
      }

      setGoalStatus(ctx, text);
      const started = startGoalProcessing(pi, ctx, text);
      ctx.ui.notify(
        `🎯 Goal set: ${truncate(text, 160)}${started === "pending" ? " (goal processing already pending)" : started === "budget_exhausted" ? " (budget exhausted)" : " — processing started"}`,
        "info",
      );
    },
  });
}
