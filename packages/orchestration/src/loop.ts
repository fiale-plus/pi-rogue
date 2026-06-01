import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendText, featureFile, readText, sessionFile, sessionKey, truncate } from "./internal.js";
import { clearResearchState, hasActiveResearch } from "./autoresearch-state.js";
import { setAdvisorCheckinsEnabled } from "./advisor-checkins.js";
import { buildGoalCheckPrompt, beginGoalCheck, hasGoalCheckPending } from "./goal-resolution.js";
import { readSessionJson, writeSessionJson } from "./state.js";
import { loopArgumentCompletions } from "./completions.js";
import { advisorCheckinReason, budgetFlowReason, clearBudgetState, readBudgetState, recordAdvisorCheckin } from "./budget.js";
import { clearGoal, setGoalStatus } from "./goal.js";

const FEATURE = "orchestration";
const LOOP_FILE = "loop.json";
const GOAL_FILE = "goal.md";
const LOOP_HISTORY_FILE = featureFile(FEATURE, "loop-history.jsonl");
const MIN_INTERVAL_MS = 60_000;
const loopTimers = new Map<string, NodeJS.Timeout>();

type LoopState = {
  enabled: boolean;
  interval: string;
  instruction: string;
  updatedAt: string;
};

function defaultLoopState(): LoopState {
  return {
    enabled: false,
    interval: "",
    instruction: "",
    updatedAt: "",
  };
}

function activeGoal(ctx: any): string {
  return readText(sessionFile(FEATURE, ctx, GOAL_FILE)).trim();
}

export function readLoopState(ctx: any): LoopState {
  return readSessionJson(FEATURE, ctx, LOOP_FILE, defaultLoopState());
}

function writeLoopState(ctx: any, state: LoopState): LoopState {
  const next: LoopState = { ...state, updatedAt: new Date().toISOString() };
  writeSessionJson(FEATURE, ctx, LOOP_FILE, next);
  return next;
}

function clearLoopState(ctx: any): LoopState {
  return writeLoopState(ctx, defaultLoopState());
}

function archiveLoopState(ctx: any, previous: LoopState): void {
  if (!previous.enabled && !previous.instruction && !previous.interval) return;
  appendText(LOOP_HISTORY_FILE, `${JSON.stringify({
    at: new Date().toISOString(),
    session: sessionKey(ctx),
    previous,
  })}\n`);
}

export function clearLoop(ctx: any, options: { clearResearch?: boolean; preserveCheckins?: boolean } = {}): LoopState {
  const current = readLoopState(ctx);
  archiveLoopState(ctx, current);
  const next = clearLoopState(ctx);
  stopLoopTimer(sessionKey(ctx));
  setLoopStatus(ctx, next);
  if (!options.preserveCheckins) {
    setAdvisorCheckinsEnabled(false);
  }
  if (options.clearResearch) {
    clearResearchState(ctx);
  }
  clearBudgetState(ctx);
  return next;
}

function parseIntervalMs(interval: string): number | null {
  const raw = interval.trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(value * multiplier);
  return ms >= MIN_INTERVAL_MS ? ms : null;
}

function formatLoopState(state: LoopState): string {
  if (!state.enabled) {
    return "No active loop.";
  }

  const target = state.instruction ? ` — ${truncate(state.instruction, 160)}` : "";
  return `↻ Loop active: every ${state.interval}${target}`;
}

function setLoopStatus(ctx: any, state: LoopState): void {
  ctx.ui.setStatus(
    "orchestration-loop",
    state.enabled ? `↻ ${state.interval}${state.instruction ? ` · ${truncate(state.instruction, 40)}` : ""}` : undefined,
  );
}

function stopLoopTimer(key: string): void {
  const timer = loopTimers.get(key);
  if (timer) {
    clearInterval(timer);
    loopTimers.delete(key);
  }
}

let advisorLoopCheckinFn: ((pi: ExtensionAPI, ctx: any, source?: string) => Promise<boolean>) | null | undefined;

async function runAdvisorCheckinTick(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (advisorLoopCheckinFn === undefined) {
    try {
      const advisor = await import("@fiale-plus/pi-rogue-advisor");
      const candidate = (advisor as { requestAdvisorLoopCheckin?: (pi: ExtensionAPI, ctx: any, source?: string) => Promise<boolean> }).requestAdvisorLoopCheckin;
      advisorLoopCheckinFn = typeof candidate === "function" ? candidate : null;
    } catch {
      advisorLoopCheckinFn = null;
    }
  }

  if (!advisorLoopCheckinFn) return;
  const before = readBudgetState(ctx);
  const checkinBudgetReason = advisorCheckinReason(before);
  if (checkinBudgetReason) {
    setAdvisorCheckinsEnabled(false);
    return;
  }

  await advisorLoopCheckinFn(pi, ctx, "loop_tick");
  const after = recordAdvisorCheckin(ctx);
  if (advisorCheckinReason(after)) {
    setAdvisorCheckinsEnabled(false);
  }
}

function runLoopTick(pi: ExtensionAPI, ctx: any): boolean {
  const key = sessionKey(ctx);
  const current = readLoopState(ctx);
  if (!current.enabled || !current.instruction) {
    stopLoopTimer(key);
    setLoopStatus(ctx, current);
    return false;
  }

  const currentIntervalMs = parseIntervalMs(current.interval);
  if (currentIntervalMs === null) {
    stopLoopTimer(key);
    setLoopStatus(ctx, current);
    ctx.ui.notify("Loop interval must be at least 1m (e.g. 1m, 5m, 1h).", "warning");
    return false;
  }

  const goal = activeGoal(ctx);
  if (goal) {
    const budgetReason = budgetFlowReason(readBudgetState(ctx));
    if (budgetReason) {
      clearGoal(ctx);
      clearLoop(ctx, { clearResearch: true });
      setGoalStatus(ctx, null);
      ctx.ui.notify(`🧭 Goal budget exhausted: ${budgetReason}.`, "warning");
      return false;
    }
  }

  if (goal && hasGoalCheckPending(ctx)) {
    void runAdvisorCheckinTick(pi, ctx);
    return false;
  }

  const prompt = goal ? buildGoalCheckPrompt(goal, current.instruction) : current.instruction;
  ctx.ui.notify(goal ? `🎯 Goal check: ${truncate(goal, 80)}` : `↻ Loop tick: ${truncate(current.instruction, 80)}`, "info");
  if (goal) {
    beginGoalCheck(ctx);
  }

  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  void runAdvisorCheckinTick(pi, ctx);
  return true;
}

function syncLoopTimer(pi: ExtensionAPI, ctx: any): void {
  const key = sessionKey(ctx);
  stopLoopTimer(key);

  const state = readLoopState(ctx);
  setLoopStatus(ctx, state);
  if (!state.enabled || !state.instruction) {
    setAdvisorCheckinsEnabled(false);
    return;
  }

  const intervalMs = parseIntervalMs(state.interval);
  if (intervalMs === null) {
    ctx.ui.notify("Loop interval must be at least 1m (e.g. 1m, 5m, 1h).", "warning");
    setAdvisorCheckinsEnabled(false);
    return;
  }

  setAdvisorCheckinsEnabled(true);
  const tick = () => {
    const currentIntervalMs = parseIntervalMs(readLoopState(ctx).interval);
    if (currentIntervalMs === null || currentIntervalMs !== intervalMs) {
      syncLoopTimer(pi, ctx);
      return;
    }

    runLoopTick(pi, ctx);
  };

  loopTimers.set(key, setInterval(tick, intervalMs));
}

export function startLoop(pi: ExtensionAPI, ctx: any, interval: string, instruction: string, options: { triggerNow?: boolean } = {}): LoopState | null {
  if (!interval || !instruction || parseIntervalMs(interval) === null) {
    return null;
  }

  const next = writeLoopState(ctx, {
    enabled: true,
    interval,
    instruction,
    updatedAt: "",
  });
  setAdvisorCheckinsEnabled(true);
  setLoopStatus(ctx, next);
  syncLoopTimer(pi, ctx);
  if (options.triggerNow) {
    triggerLoopTick(pi, ctx);
  }
  return next;
}

export function triggerLoopTick(pi: ExtensionAPI, ctx: any): boolean {
  return runLoopTick(pi, ctx);
}

export function registerLoop(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueLoopRegistered) return;
  p.__piRogueLoopRegistered = true;

  pi.on("session_start", (_event, ctx) => {
    syncLoopTimer(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopLoopTimer(sessionKey(ctx));
    setLoopStatus(ctx, defaultLoopState());
  });

  pi.registerCommand("loop", {
    description: "Record, show, or clear the current session loop cadence",
    getArgumentCompletions: (prefix: string) => loopArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, ...rest] = input.split(/\s+/);
      const resolved = !input ? "status" : ["status", "show", "off", "clear", "stop"].includes(cmd) ? cmd : "set";

      if (resolved === "status" || resolved === "show") {
        ctx.ui.notify(formatLoopState(readLoopState(ctx)), "info");
        return;
      }

      if (resolved === "off" || resolved === "clear" || resolved === "stop") {
        const clearedResearch = hasActiveResearch(ctx);
        const next = clearLoop(ctx, { clearResearch: true });
        ctx.ui.notify(next.enabled ? formatLoopState(next) : `Loop cleared${clearedResearch ? "; autoresearch status cleared" : ""}.`, "info");
        return;
      }

      const interval = cmd;
      const instruction = rest.join(" ").trim();
      if (!interval || !instruction || parseIntervalMs(interval) === null) {
        ctx.ui.notify("Usage: /loop <interval> <instruction> (e.g. 1m, 5m, 1h)", "error");
        return;
      }

      clearLoop(ctx, { clearResearch: true });
      const next = startLoop(pi, ctx, interval, instruction);
      if (!next) {
        ctx.ui.notify("Usage: /loop <interval> <instruction> (e.g. 1m, 5m, 1h)", "error");
        return;
      }
      ctx.ui.notify(formatLoopState(next), "info");
    },
  });
}
