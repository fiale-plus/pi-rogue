import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeGoal, clearGoal, setGoal, setGoalStatus } from "./goal.js";
import { clearLoop, startLoop } from "./loop.js";
import {
  DEFAULT_RESEARCH_INTERVAL,
  formatResearchState,
  label,
  readResearchState,
  writeResearchState,
  type ResearchKind,
} from "./autoresearch-state.js";
import { appendText, featureFile } from "./internal.js";
import { initializeBudgetState, readBudgetState } from "./budget.js";
import { autoresearchArgumentCompletions } from "./completions.js";

export function buildResearchGoal(kind: ResearchKind, instruction: string): string {
  if (kind === "autoresearch-lab") {
    return [
      `Autoresearch lab: ${instruction}`,
      "Setup gate before implementation:",
      "- define the source seed/objective, hypotheses, measurement method, baseline/current state, durable artifacts, and stop condition",
      "- split the scope into independent lanes with a hypothesis, eval method, and expected artifact for each lane",
      "- do not simplify, re-aim, or replace the user objective unless the user explicitly asks",
      "Success criteria:",
      "- preserve isolated/non-overlapping work where possible",
      "- evaluate candidate findings before merging them into the main path",
      "- run checks after integration and summarize winning/losing hypotheses",
      "- write down convergent findings, rejected hypotheses, limitations, and follow-up seeds when complete",
    ].join("\n");
  }

  return [
    `Autoresearch: ${instruction}`,
    "Setup gate before implementation:",
    "- define the hypothesis/objective, measurable target, baseline/current state, benchmark/evaluation command, durable artifact/log, and stop condition",
    "- if no metric or benchmark exists, the first concrete action is to inspect and create or identify one",
    "- do not simplify, re-aim, or replace the user objective unless the user explicitly asks",
    "Success criteria:",
    "- run iterative identify → implement → build/check → test/evaluate → sanity → log cycles",
    "- preserve the benchmark/evaluation script as the durable product",
    "- complete at least two loop cycles before declaring done unless the user manually clears it",
    "- stop only when the metric/answer is materially improved and the result is summarized with evidence",
  ].join("\n");
}

export function buildResearchLoopInstruction(kind: ResearchKind, instruction: string): string {
  if (kind === "autoresearch-lab") {
    return [
      "Run one autoresearch-lab cycle toward the active goal.",
      `User instruction: ${instruction}`,
      "Before changing code, confirm or create the setup: source objective, hypotheses, lane split, measurement/eval method, baseline/current state, durable artifacts, and stop condition.",
      "Plan or update independent lanes, delegate/inspect where useful, evaluate candidate results, integrate only safe non-conflicting improvements, run checks, and log the next hypothesis.",
      "Do not simplify or re-aim the objective unless the user explicitly asks; preserve the active research question.",
    ].join("\n");
  }

  return [
    "Run one autoresearch cycle toward the active goal.",
    `User instruction: ${instruction}`,
    "Before changing code, confirm or create the setup: hypothesis/objective, measurable target, baseline/current state, benchmark/evaluation command, durable artifact/log, and stop condition.",
    "If no metric or benchmark exists, inspect and create or identify one before implementation.",
    "Measure or define the target, inspect evidence, make the highest-leverage safe change, run checks/evaluation, record the result, and choose the next hypothesis. Do not declare GOAL_DONE before at least two autoresearch cycles have produced explicit check/evaluation evidence.",
    "Do not simplify or re-aim the objective unless the user explicitly asks; preserve the active research question.",
  ].join("\n");
}

function registerResearchCommand(pi: ExtensionAPI, commandName: ResearchKind): void {
  const prefix = label(commandName);

  pi.registerCommand(commandName, {
    description: commandName === "autoresearch-lab"
      ? "Parallel multi-agent research mode backed by goal + loop"
      : "Iterative optimization/research mode backed by goal + loop",
    getArgumentCompletions: (prefix: string) => autoresearchArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd] = input.split(/\s+/);
      const resolved = !input ? "status" : ["status", "show"].includes(cmd) ? cmd : ["off", "clear", "stop"].includes(cmd) ? "clear" : "set";

      if (resolved === "status" || resolved === "show") {
        ctx.ui.notify(formatResearchState(readResearchState(ctx), readBudgetState(ctx)), "info");
        return;
      }

      if (resolved === "clear") {
        const previous = readResearchState(ctx);
        if (previous.instruction) {
          appendText(featureFile("orchestration", "autoresearch-history.jsonl"), `${JSON.stringify({
            at: new Date().toISOString(),
            action: "clear",
            previous,
          })}\n`);
        }

        clearLoop(ctx, { clearResearch: true, preserveCheckins: true });
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

      const previous = readResearchState(ctx);
      if (previous.instruction) {
        appendText(featureFile("orchestration", "autoresearch-history.jsonl"), `${JSON.stringify({
          at: new Date().toISOString(),
          action: "replace",
          previous,
        })}\n`);
      }

      const goal = buildResearchGoal(commandName, instruction);
      const loopInstruction = buildResearchLoopInstruction(commandName, instruction);
      setGoal(ctx, goal);
      setGoalStatus(ctx, goal);
      initializeBudgetState(ctx, commandName);
      const next = writeResearchState(ctx, {
        kind: commandName,
        instruction,
        goal,
        loopInstruction,
        interval: DEFAULT_RESEARCH_INTERVAL,
        cycles: 0,
        doneAttempts: 0,
        updatedAt: "",
      });
      const loop = startLoop(pi, ctx, DEFAULT_RESEARCH_INTERVAL, loopInstruction, { triggerNow: true });
      if (!loop) {
        ctx.ui.notify(`${prefix} could not start: invalid loop interval.`, "error");
        return;
      }
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
