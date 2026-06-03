import { appendText, featureFile, sessionKey, truncate } from "./internal.js";
import { readSessionJson, writeSessionJson } from "./state.js";

export const FEATURE = "orchestration";
export const RESEARCH_FILE = "autoresearch.json";
export const DEFAULT_RESEARCH_INTERVAL = "5m";
export const RESEARCH_HISTORY_FILE = featureFile(FEATURE, "autoresearch-history.jsonl");

export type ResearchKind = "autoresearch" | "autoresearch-lab";

export type ResearchState = {
  kind: ResearchKind;
  instruction: string;
  goal?: string;
  loopInstruction?: string;
  interval?: string;
  cycles?: number;
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

export type ResearchHistoryResult = "done" | "continue" | "unknown";

export type ResearchHistoryEntry = {
  at: string;
  session: string;
  kind: ResearchKind;
  instruction: string;
  goal: string;
  result: ResearchHistoryResult;
  cycle: number;
  evidence?: string;
};

export function appendResearchHistory(ctx: any, state: ResearchState, result: ResearchHistoryResult, evidence = ""): void {
  const goal = String(state.goal ?? "").trim();
  if (!goal) return;

  const next: ResearchHistoryEntry = {
    at: new Date().toISOString(),
    session: sessionKey(ctx),
    kind: state.kind,
    instruction: state.instruction,
    goal,
    result,
    cycle: (state.cycles ?? 0) + 1,
  };
  const cleanEvidence = String(evidence ?? "").trim();
  if (cleanEvidence) {
    next.evidence = cleanEvidence.slice(0, 240);
  }

  appendText(RESEARCH_HISTORY_FILE, `${JSON.stringify(next)}\n`);
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
  const last = state.lastResult ? `, last=${state.lastResult}` : "";
  return `${label(state.kind)} active: ${truncate(state.instruction, 160)} — /loop ${state.interval || DEFAULT_RESEARCH_INTERVAL}; cycles=${cycles}${last}`;
}
