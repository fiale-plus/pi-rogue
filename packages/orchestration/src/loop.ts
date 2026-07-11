import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendText, featureFile, readText, sessionFile, sessionKey, truncate } from "./internal.js";
import { clearResearchState, hasActiveResearch } from "./autoresearch-state.js";
import { setAdvisorCheckinDemand } from "./advisor-checkins.js";
import { buildGoalCheckPrompt, beginGoalCheck, hasGoalCheckPending } from "./goal-resolution.js";
import { clearNoProgressRecovery } from "./novelty-guard.js";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const LOOP_FILE = "loop.json";
const GOAL_FILE = "goal.md";
const LOOP_HISTORY_FILE = featureFile(FEATURE, "loop-history.jsonl");
const MIN_INTERVAL_MS = 60_000;
const loopTimers = new Map<string, NodeJS.Timeout>();
type OutstandingTick = { generation: number; requestId: string };
const outstandingTicks = new Map<string, OutstandingTick>();

type LoopState = {
  enabled: boolean;
  interval: string;
  instruction: string;
  updatedAt: string;
  generation: number;
};

function defaultLoopState(): LoopState {
  return {
    enabled: false,
    interval: "",
    instruction: "",
    updatedAt: "",
    generation: 0,
  };
}

function normalizeLoopState(state: Partial<LoopState> | null | undefined): LoopState {
  const fallback = defaultLoopState();
  const generation = state?.generation;
  return {
    enabled: Boolean(state?.enabled),
    interval: typeof state?.interval === "string" ? state.interval : fallback.interval,
    instruction: typeof state?.instruction === "string" ? state.instruction : fallback.instruction,
    updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : fallback.updatedAt,
    generation: typeof generation === "number" && Number.isFinite(generation) ? generation : fallback.generation,
  };
}

function activeGoal(ctx: any): string {
  return readText(sessionFile(FEATURE, ctx, GOAL_FILE)).trim();
}

export function readLoopState(ctx: any): LoopState {
  return normalizeLoopState(readSessionJson(FEATURE, ctx, LOOP_FILE, defaultLoopState()));
}

function writeLoopState(ctx: any, state: Partial<LoopState>): LoopState {
  const current = readLoopState(ctx);
  const next: LoopState = normalizeLoopState({
    ...current,
    ...state,
    updatedAt: new Date().toISOString(),
    generation: Number.isFinite(state.generation) ? Number(state.generation) : current.generation,
  });
  writeSessionJson(FEATURE, ctx, LOOP_FILE, next);
  return next;
}

function clearLoopState(ctx: any): LoopState {
  const current = readLoopState(ctx);
  return writeLoopState(ctx, {
    ...defaultLoopState(),
    generation: current.generation + 1,
  });
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
  const key = sessionKey(ctx);
  outstandingTicks.delete(key);
  const current = readLoopState(ctx);
  archiveLoopState(ctx, current);
  const next = clearLoopState(ctx);
  clearNoProgressRecovery(ctx);
  stopLoopTimer(key);
  setLoopStatus(ctx, next);
  setAdvisorCheckinDemand(ctx, "loop", false);
  if (options.clearResearch) {
    clearResearchState(ctx);
  }
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

export function formatLoopState(state: LoopState): string {
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
  await advisorLoopCheckinFn(pi, ctx, "loop_tick");
}

function plainTickPrompt(instruction: string, tick: OutstandingTick): string {
  return `[PI_ROGUE_LOOP_TICK v1 request=${tick.requestId} generation=${tick.generation}]\n${instruction}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function deliveredPlainTick(event: any, tick: OutstandingTick): boolean {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const expected = plainTickPrompt("", tick).split("\n", 1)[0];
  const markers = messages
    .filter((message: any) => message?.role === "user")
    .map((message: any) => messageText(message.content).split("\n", 1)[0]?.trim() ?? "")
    .filter((line: string) => line.startsWith("[PI_ROGUE_LOOP_TICK"));
  return markers.at(-1) === expected && markers.filter((marker: string) => marker === expected).length === 1;
}

function runLoopTick(pi: ExtensionAPI, ctx: any, generation?: number): boolean {
  const key = sessionKey(ctx);
  const current = readLoopState(ctx);
  const activeGeneration = generation ?? current.generation;
  if (activeGeneration !== current.generation) {
    return false;
  }
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

  const pendingTick = outstandingTicks.get(key);
  if (pendingTick?.generation === activeGeneration) return false;
  if (pendingTick) outstandingTicks.delete(key);

  const goal = activeGoal(ctx);
  if (goal && hasGoalCheckPending(ctx)) {
    if (activeGeneration !== current.generation) return false;
    void runAdvisorCheckinTick(pi, ctx);
    return false;
  }
  if (!goal && (ctx.isIdle?.() === false || ctx.hasPendingMessages?.() === true)) return false;

  const live = readLoopState(ctx);
  if (activeGeneration !== live.generation || !live.enabled || !live.instruction || live.instruction !== current.instruction || parseIntervalMs(live.interval) !== currentIntervalMs) {
    return false;
  }

  const request = goal ? beginGoalCheck(ctx, goal) : undefined;
  const tick = goal ? undefined : { generation: activeGeneration, requestId: randomUUID() };
  const prompt = request
    ? buildGoalCheckPrompt(goal, current.instruction, request)
    : plainTickPrompt(current.instruction, tick!);
  if (tick) outstandingTicks.set(key, tick);
  try {
    if (ctx.isIdle?.() === false) {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(prompt);
    }
  } catch (error) {
    if (tick) outstandingTicks.delete(key);
    throw error;
  }

  ctx.ui.notify(goal ? `🎯 Goal check: ${truncate(goal, 80)}` : `↻ Loop tick: ${truncate(current.instruction, 80)}`, "info");
  void runAdvisorCheckinTick(pi, ctx);
  return true;
}

function syncLoopTimer(pi: ExtensionAPI, ctx: any): void {
  const key = sessionKey(ctx);
  stopLoopTimer(key);

  const state = readLoopState(ctx);
  setLoopStatus(ctx, state);
  if (!state.enabled || !state.instruction) {
    setAdvisorCheckinDemand(ctx, "loop", false);
    return;
  }

  const intervalMs = parseIntervalMs(state.interval);
  if (intervalMs === null) {
    ctx.ui.notify("Loop interval must be at least 1m (e.g. 1m, 5m, 1h).", "warning");
    setAdvisorCheckinDemand(ctx, "loop", false);
    return;
  }

  setAdvisorCheckinDemand(ctx, "loop", true);
  const generation = state.generation;
  const tick = () => {
    const currentIntervalMs = parseIntervalMs(readLoopState(ctx).interval);
    if (currentIntervalMs === null || currentIntervalMs !== intervalMs) {
      syncLoopTimer(pi, ctx);
      return;
    }

    runLoopTick(pi, ctx, generation);
  };

  loopTimers.set(key, setInterval(tick, intervalMs));
}

export function startLoop(pi: ExtensionAPI, ctx: any, interval: string, instruction: string, options: { triggerNow?: boolean } = {}): LoopState | null {
  if (!interval || !instruction || parseIntervalMs(interval) === null) {
    return null;
  }

  clearNoProgressRecovery(ctx);
  outstandingTicks.delete(sessionKey(ctx));
  const current = readLoopState(ctx);
  const next = writeLoopState(ctx, {
    enabled: true,
    interval,
    instruction,
    updatedAt: "",
    generation: current.generation + 1,
  });
  setAdvisorCheckinDemand(ctx, "loop", true);
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
    outstandingTicks.delete(sessionKey(ctx));
    syncLoopTimer(pi, ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    const key = sessionKey(ctx);
    const tick = outstandingTicks.get(key);
    if (tick?.generation === readLoopState(ctx).generation && deliveredPlainTick(event, tick)) {
      outstandingTicks.delete(key);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    outstandingTicks.delete(key);
    const current = readLoopState(ctx);
    writeLoopState(ctx, { generation: current.generation + 1 });
    stopLoopTimer(key);
    setLoopStatus(ctx, defaultLoopState());
  });

}

export async function handleLoopCommand(pi: ExtensionAPI, args: unknown, ctx: any): Promise<void> {
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
    ctx.ui.notify("Usage: /pi-rogue-orchestration loop <interval> <instruction> (e.g. 1m, 5m, 1h)", "error");
    return;
  }

  clearLoop(ctx, { clearResearch: true });
  const next = startLoop(pi, ctx, interval, instruction);
  if (!next) {
    ctx.ui.notify("Usage: /pi-rogue-orchestration loop <interval> <instruction> (e.g. 1m, 5m, 1h)", "error");
    return;
  }
  ctx.ui.notify(formatLoopState(next), "info");
}
