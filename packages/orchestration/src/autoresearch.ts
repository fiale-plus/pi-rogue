import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "./internal.js";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const RESEARCH_FILE = "autoresearch.json";

type ResearchKind = "autoresearch" | "autoresearch-lab";

type ResearchState = {
  kind: ResearchKind;
  instruction: string;
  updatedAt: string;
};

function defaultResearchState(kind: ResearchKind): ResearchState {
  return {
    kind,
    instruction: "",
    updatedAt: "",
  };
}

function readResearchState(ctx: any): ResearchState {
  return readSessionJson(FEATURE, ctx, RESEARCH_FILE, defaultResearchState("autoresearch"));
}

function writeResearchState(ctx: any, state: ResearchState): ResearchState {
  const next: ResearchState = { ...state, updatedAt: new Date().toISOString() };
  writeSessionJson(FEATURE, ctx, RESEARCH_FILE, next);
  return next;
}

function clearResearchState(ctx: any): ResearchState {
  return writeResearchState(ctx, defaultResearchState("autoresearch"));
}

function formatResearchState(state: ResearchState): string {
  if (!state.instruction) {
    return `${state.kind === "autoresearch-lab" ? "🧪 Autoresearch lab" : "🔎 Autoresearch"} is off.`;
  }

  const prefix = state.kind === "autoresearch-lab" ? "🧪 Autoresearch lab" : "🔎 Autoresearch";
  return `${prefix}: ${truncate(state.instruction, 160)}`;
}

function registerResearchCommand(pi: ExtensionAPI, commandName: ResearchKind): void {
  const isLab = commandName === "autoresearch-lab";
  const prefix = isLab ? "🧪 Autoresearch lab" : "🔎 Autoresearch";

  pi.registerCommand(commandName, {
    description: isLab
      ? "Parallel multi-agent research mode for the current session"
      : "Iterative optimization mode for the current session",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd] = input.split(/\s+/);
      const resolved = !input ? "status" : ["status", "show"].includes(cmd) ? cmd : ["off", "clear", "stop"].includes(cmd) ? "clear" : "set";

      if (resolved === "status" || resolved === "show") {
        ctx.ui.notify(formatResearchState(readResearchState(ctx)), "info");
        return;
      }

      if (resolved === "clear") {
        clearResearchState(ctx);
        ctx.ui.notify(`${prefix} cleared.`, "info");
        return;
      }

      const instruction = input;
      if (!instruction) {
        ctx.ui.notify(`Usage: /${commandName} <instruction>`, "error");
        return;
      }

      const next = writeResearchState(ctx, {
        kind: commandName,
        instruction,
        updatedAt: "",
      });
      ctx.ui.notify(formatResearchState(next), "info");
    },
  });
}

export function registerAutoresearch(pi: ExtensionAPI): void {
  registerResearchCommand(pi, "autoresearch");
}

export function registerAutoresearchLab(pi: ExtensionAPI): void {
  registerResearchCommand(pi, "autoresearch-lab");
}
