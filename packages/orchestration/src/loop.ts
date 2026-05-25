import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionKey, truncate } from "./internal.js";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const LOOP_FILE = "loop.json";
const MIN_INTERVAL_MS = 1000;
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

function readLoopState(ctx: any): LoopState {
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

function syncLoopTimer(pi: ExtensionAPI, ctx: any): void {
  const key = sessionKey(ctx);
  stopLoopTimer(key);

  const state = readLoopState(ctx);
  setLoopStatus(ctx, state);
  if (!state.enabled || !state.instruction) {
    return;
  }

  const intervalMs = parseIntervalMs(state.interval);
  if (intervalMs === null) {
    ctx.ui.notify("Loop interval must be at least 1s (e.g. 10s, 1m, 2500ms).", "warning");
    return;
  }

  const tick = () => {
    const current = readLoopState(ctx);
    if (!current.enabled || !current.instruction) {
      stopLoopTimer(key);
      setLoopStatus(ctx, current);
      return;
    }

    const currentIntervalMs = parseIntervalMs(current.interval);
    if (currentIntervalMs === null || currentIntervalMs !== intervalMs) {
      syncLoopTimer(pi, ctx);
      return;
    }

    ctx.ui.notify(`↻ Loop tick: ${truncate(current.instruction, 80)}`, "info");
    if (ctx.isIdle()) {
      pi.sendUserMessage(current.instruction);
    } else {
      pi.sendUserMessage(current.instruction, { deliverAs: "followUp" });
    }
  };

  loopTimers.set(key, setInterval(tick, intervalMs));
}

export function registerLoop(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    syncLoopTimer(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopLoopTimer(sessionKey(ctx));
    setLoopStatus(ctx, defaultLoopState());
  });

  pi.registerCommand("loop", {
    description: "Record, show, or clear the current session loop cadence",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, ...rest] = input.split(/\s+/);
      const resolved = !input ? "status" : ["status", "show", "off", "clear", "stop"].includes(cmd) ? cmd : "set";

      if (resolved === "status" || resolved === "show") {
        ctx.ui.notify(formatLoopState(readLoopState(ctx)), "info");
        return;
      }

      if (resolved === "off" || resolved === "clear" || resolved === "stop") {
        const next = clearLoopState(ctx);
        stopLoopTimer(sessionKey(ctx));
        setLoopStatus(ctx, next);
        ctx.ui.notify(next.enabled ? formatLoopState(next) : "Loop cleared.", "info");
        return;
      }

      const interval = cmd;
      const instruction = rest.join(" ").trim();
      if (!interval || !instruction || parseIntervalMs(interval) === null) {
        ctx.ui.notify("Usage: /loop <interval> <instruction> (e.g. 10s, 1m, 2500ms)", "error");
        return;
      }

      const next = writeLoopState(ctx, {
        enabled: true,
        interval,
        instruction,
        updatedAt: "",
      });
      setLoopStatus(ctx, next);
      syncLoopTimer(pi, ctx);
      ctx.ui.notify(formatLoopState(next), "info");
    },
  });
}
