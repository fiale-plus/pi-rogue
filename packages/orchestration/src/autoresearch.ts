import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeGoal, clearGoal, setGoal, setGoalStatus } from "./goal.js";
import { clearLoop, startLoop } from "./loop.js";
import { truncate } from "./internal.js";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const RESEARCH_FILE = "autoresearch.json";
const DEFAULT_INTERVAL = "5m";

type ResearchKind = "autoresearch" | "autoresearch-lab";

export type ResearchState = {
  kind: ResearchKind;
  instruction: string;
  goal?: string;
  loopInstruction?: string;
  interval?: string;
  cycles?: number;
  doneAttempts?: number;
  lastResult?: "done" | "continue" | "unknown";
  updatedAt: string;
};

function defaultResearchState(kind: ResearchKind): ResearchState {
  return {
    kind,
    instruction: "",
    goal: "",
    loopInstruction: "",
    interval: DEFAULT_INTERVAL,
    cycles: 0,
    doneAttempts: 0,
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

function label(kind: ResearchKind): string {
  return kind === "autoresearch-lab" ? "🧪 Autoresearch lab" : "🔎 Autoresearch";
}

function buildResearchGoal(kind: ResearchKind, instruction: string): string {
  if (kind === "autoresearch-lab") {
    return [
      `Autoresearch lab: ${instruction}`,
      "Success criteria:",
      "- split the scope into independent research lanes before changing code",
      "- preserve isolated/non-overlapping work where possible",
      "- evaluate candidate findings before merging them into the main path",
      "- run checks after integration and summarize winning/losing hypotheses",
    ].join("\n");
  }

  return [
    `Autoresearch: ${instruction}`,
    "Success criteria:",
    "- make the target measurable; identify or create the benchmark/evaluation command when useful",
    "- run iterative identify → implement → build/check → test/evaluate → sanity → log cycles",
    "- preserve the benchmark/evaluation script as the durable product",
    "- complete at least two loop cycles before declaring done unless the user manually clears it",
    "- stop only when the metric/answer is materially improved and the result is summarized with evidence",
  ].join("\n");
}

function buildResearchLoopInstruction(kind: ResearchKind, instruction: string): string {
  if (kind === "autoresearch-lab") {
    return [
      "Run one autoresearch-lab cycle toward the active goal.",
      `User instruction: ${instruction}`,
      "Plan or update independent lanes, delegate/inspect where useful, evaluate candidate results, integrate only safe non-conflicting improvements, run checks, and log the next hypothesis.",
    ].join("\n");
  }

  return [
    "Run one autoresearch cycle toward the active goal.",
    `User instruction: ${instruction}`,
    "Measure or define the target, inspect evidence, make the highest-leverage safe change, run checks/evaluation, record the result, and choose the next hypothesis. Do not declare GOAL_DONE before at least two autoresearch cycles have produced explicit check/evaluation evidence.",
  ].join("\n");
}

export function formatResearchState(state: ResearchState): string {
  if (!state.instruction) {
    return `${label(state.kind)} is off.`;
  }

  const cycles = state.cycles ?? 0;
  const doneAttempts = state.doneAttempts ?? 0;
  const last = state.lastResult ? `, last=${state.lastResult}` : "";
  return `${label(state.kind)} active: ${truncate(state.instruction, 160)} — backed by /goal + /loop ${state.interval || DEFAULT_INTERVAL}; cycles=${cycles}, doneAttempts=${doneAttempts}${last}`;
}

function registerResearchCommand(pi: ExtensionAPI, commandName: ResearchKind): void {
  const prefix = label(commandName);

  pi.registerCommand(commandName, {
    description: commandName === "autoresearch-lab"
      ? "Parallel multi-agent research mode backed by goal + loop"
      : "Iterative optimization/research mode backed by goal + loop",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd] = input.split(/\s+/);
      const resolved = !input ? "status" : ["status", "show"].includes(cmd) ? cmd : ["off", "clear", "stop"].includes(cmd) ? "clear" : "set";

      if (resolved === "status" || resolved === "show") {
        ctx.ui.notify(formatResearchState(readResearchState(ctx)), "info");
        return;
      }

      if (resolved === "clear") {
        const previous = readResearchState(ctx);
        clearResearchState(ctx);
        clearLoop(ctx);
        const clearedGoal = Boolean(previous.goal && activeGoal(ctx) === previous.goal);
        if (clearedGoal) {
          clearGoal(ctx);
          setGoalStatus(ctx, null);
        }
        ctx.ui.notify(`${prefix} cleared; underlying loop stopped${clearedGoal ? " and matching goal cleared" : ""}.`, "info");
        return;
      }

      const instruction = input;
      if (!instruction) {
        ctx.ui.notify(`Usage: /${commandName} <instruction>`, "error");
        return;
      }

      const goal = buildResearchGoal(commandName, instruction);
      const loopInstruction = buildResearchLoopInstruction(commandName, instruction);
      setGoal(ctx, goal);
      setGoalStatus(ctx, goal);
      const loop = startLoop(pi, ctx, DEFAULT_INTERVAL, loopInstruction, { triggerNow: true });
      if (!loop) {
        ctx.ui.notify(`${prefix} could not start: invalid loop interval.`, "error");
        return;
      }

      const next = writeResearchState(ctx, {
        kind: commandName,
        instruction,
        goal,
        loopInstruction,
        interval: loop.interval,
        cycles: 0,
        doneAttempts: 0,
        updatedAt: "",
      });
      ctx.ui.notify(`${formatResearchState(next)}. First cycle queued now.`, "info");
    },
  });
}

export function registerAutoresearch(pi: ExtensionAPI): void {
  registerResearchCommand(pi, "autoresearch");
}

export function registerAutoresearchLab(pi: ExtensionAPI): void {
  registerResearchCommand(pi, "autoresearch-lab");
}
