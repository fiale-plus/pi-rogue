import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "./internal.js";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const LOOP_FILE = "loop.json";

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

function formatLoopState(state: LoopState): string {
  if (!state.enabled) {
    return "No active loop.";
  }

  const target = state.instruction ? ` — ${truncate(state.instruction, 160)}` : "";
  return `↻ Loop active: every ${state.interval}${target}`;
}

export function registerLoop(pi: ExtensionAPI): void {
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
        ctx.ui.notify(next.enabled ? formatLoopState(next) : "Loop cleared.", "info");
        return;
      }

      const interval = cmd;
      const instruction = rest.join(" ").trim();
      if (!interval || !instruction) {
        ctx.ui.notify("Usage: /loop <interval> <instruction>", "error");
        return;
      }

      const next = writeLoopState(ctx, {
        enabled: true,
        interval,
        instruction,
        updatedAt: "",
      });
      ctx.ui.notify(formatLoopState(next), "info");
    },
  });
}
