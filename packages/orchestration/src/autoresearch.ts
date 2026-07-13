import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeGoal, clearGoal, setGoal, setGoalStatus } from "./goal.js";
import { clearLoop, readLoopState, startLoop } from "./loop.js";
import {
  DEFAULT_RESEARCH_INTERVAL,
  formatResearchState,
  label,
  readResearchState,
  writeResearchState,
  type ResearchKind,
} from "./autoresearch-state.js";

export function buildResearchGoal(kind: ResearchKind, instruction: string): string {
  if (kind === "autoresearch-lab") {
    return [
      `Autoresearch lab: ${instruction}`,
      "Define source objective, hypotheses, lane split, measurement method, baseline, artifacts, and stop condition.",
      "Run independent lanes where useful; evaluate evidence before integration; preserve the user objective unless explicitly changed.",
      "Finish with convergent findings, rejected hypotheses, limitations, checks, and follow-up seeds.",
    ].join("\n");
  }

  return [
    `Autoresearch: ${instruction}`,
    "Define hypothesis/objective, measurable target, baseline, eval/check command, durable artifact/log, and stop condition.",
    "Iterate: inspect evidence, make one high-leverage change, run the relevant check/eval, record result, choose next hypothesis.",
    "Preserve the user objective unless explicitly changed; stop only when materially improved and summarized with evidence.",
  ].join("\n");
}

export function buildResearchLoopInstruction(kind: ResearchKind, instruction: string): string {
  if (kind === "autoresearch-lab") {
    return [
      "Run one autoresearch-lab cycle toward the active goal.",
      `User instruction: ${instruction}`,
      "Confirm/update source objective, hypotheses, lane split, measurement method, baseline, artifacts, and stop condition.",
      "Advance the most useful lane comparison, evaluate evidence, integrate only safe improvements, run checks, and record the next hypothesis.",
      "Do not simplify or re-aim the objective unless the user explicitly asks.",
    ].join("\n");
  }

  return [
    "Run one autoresearch cycle toward the active goal.",
    `User instruction: ${instruction}`,
    "Confirm/update hypothesis, measurable target, baseline, eval/check command, artifact/log, and stop condition.",
    "Inspect evidence, take one concrete high-leverage step, run the relevant check/eval when possible, record result, and choose the next hypothesis.",
    "Do not simplify or re-aim the objective unless the user explicitly asks.",
  ].join("\n");
}

export async function handleResearchCommand(pi: ExtensionAPI, commandName: ResearchKind, args: unknown, ctx: any): Promise<void> {
  const prefix = label(commandName);
  const input = String(args ?? "").trim();
  const [cmd] = input.split(/\s+/);
  const resolved = !input ? "status" : ["status", "show"].includes(cmd) ? cmd : ["off", "clear", "stop"].includes(cmd) ? "clear" : "set";

  if (resolved === "status" || resolved === "show") {
    ctx.ui.notify(formatResearchState(readResearchState(ctx)), "info");
    return;
  }

  if (resolved === "clear") {
    const previous = readResearchState(ctx);
    clearLoop(ctx, { clearResearch: true });
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
    ctx.ui.notify(`Usage: /pi-rogue-orchestration ${commandName === "autoresearch-lab" ? "lab" : "autoresearch"} <instruction>`, "error");
    return;
  }

  const goal = buildResearchGoal(commandName, instruction);
  const loopInstruction = buildResearchLoopInstruction(commandName, instruction);
  const previous = readResearchState(ctx);
  const currentLoop = readLoopState(ctx);
  if (
    previous.kind === commandName
    && previous.instruction === instruction
    && previous.goal === goal
    && activeGoal(ctx) === goal
    && currentLoop.enabled
    && currentLoop.instruction === loopInstruction
  ) {
    ctx.ui.notify(`${prefix} already active for this instruction. No duplicate cycle queued.`, "info");
    return;
  }

  const labIsActive = previous.kind === "autoresearch-lab" && currentLoop.enabled;
  if (commandName === "autoresearch-lab" && !labIsActive) {
    const confirmed = await ctx.ui?.confirm?.(
      "Start parallel autoresearch lab?",
      "Lab mode enables escalated, parallel research lanes and queues work immediately. Continue?",
    );
    if (confirmed !== true) {
      ctx.ui.notify("Autoresearch lab activation cancelled; no goal, research, loop, or turn was changed.", "info");
      return;
    }
  }

  const restartSameGoal = activeGoal(ctx) === goal;
  setGoal(ctx, goal, { restartDuplicate: restartSameGoal });

  setGoalStatus(ctx, goal);
  const next = writeResearchState(ctx, {
    kind: commandName,
    instruction,
    goal,
    loopInstruction,
    interval: DEFAULT_RESEARCH_INTERVAL,
    cycles: 0,
    updatedAt: "",
  });
  const loop = startLoop(pi, ctx, DEFAULT_RESEARCH_INTERVAL, loopInstruction, { triggerNow: true });
  if (!loop) {
    ctx.ui.notify(`${prefix} could not start: invalid loop interval.`, "error");
    return;
  }
  ctx.ui.notify(`${formatResearchState(next)}. First cycle queued now.`, "info");
}

export function registerAutoresearch(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueAutoresearchRegistered) return;
  p.__piRogueAutoresearchRegistered = true;
}

export function registerAutoresearchLab(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueAutoresearchLabRegistered) return;
  p.__piRogueAutoresearchLabRegistered = true;
}
