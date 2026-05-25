import { truncate } from "./internal.js";
import { readSessionJson, writeSessionJson } from "./state.js";

export const FEATURE = "orchestration";
export const RESEARCH_FILE = "autoresearch.json";
export const DEFAULT_RESEARCH_INTERVAL = "5m";

export type ResearchKind = "autoresearch" | "autoresearch-lab";

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

export function defaultResearchState(kind: ResearchKind = "autoresearch"): ResearchState {
  return {
    kind,
    instruction: "",
    goal: "",
    loopInstruction: "",
    interval: DEFAULT_RESEARCH_INTERVAL,
    cycles: 0,
    doneAttempts: 0,
    updatedAt: "",
  };
}

export function readResearchState(ctx: any): ResearchState {
  return readSessionJson(FEATURE, ctx, RESEARCH_FILE, defaultResearchState("autoresearch"));
}

export function writeResearchState(ctx: any, state: ResearchState): ResearchState {
  const next: ResearchState = { ...state, updatedAt: new Date().toISOString() };
  writeSessionJson(FEATURE, ctx, RESEARCH_FILE, next);
  return next;
}

export function clearResearchState(ctx: any): ResearchState {
  return writeResearchState(ctx, defaultResearchState("autoresearch"));
}

export function clearResearchStateForGoal(ctx: any, goal: string): boolean {
  const state = readResearchState(ctx);
  if (!state.instruction || !state.goal || state.goal !== goal) return false;
  clearResearchState(ctx);
  return true;
}

export function hasActiveResearch(ctx: any): boolean {
  return Boolean(readResearchState(ctx).instruction);
}

export function label(kind: ResearchKind): string {
  return kind === "autoresearch-lab" ? "🧪 Autoresearch lab" : "🔎 Autoresearch";
}

export function formatResearchState(state: ResearchState): string {
  if (!state.instruction) {
    return `${label(state.kind)} is off.`;
  }

  const cycles = state.cycles ?? 0;
  const doneAttempts = state.doneAttempts ?? 0;
  const last = state.lastResult ? `, last=${state.lastResult}` : "";
  return `${label(state.kind)} active: ${truncate(state.instruction, 160)} — backed by /goal + /loop ${state.interval || DEFAULT_RESEARCH_INTERVAL}; cycles=${cycles}, doneAttempts=${doneAttempts}${last}`;
}
