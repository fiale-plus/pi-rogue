import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const BUDGET_FILE = "budget.json";

export type BudgetKind = "goal" | "autoresearch" | "autoresearch-lab";

export type BudgetState = {
  kind: BudgetKind;
  startedAt: string;
  turns: number;
  advisorCheckins: number;
  maxTurns: number;
  maxWallTimeMs: number;
  maxAdvisorCheckins: number;
  exhaustedReason?: string;
  advisorCheckinReason?: string;
  updatedAt: string;
};

const DEFAULT_BUDGETS: Record<BudgetKind, Pick<BudgetState, "maxTurns" | "maxWallTimeMs" | "maxAdvisorCheckins">> = {
  goal: { maxTurns: 20, maxWallTimeMs: 15 * 60_000, maxAdvisorCheckins: 3 },
  autoresearch: { maxTurns: 10, maxWallTimeMs: 10 * 60_000, maxAdvisorCheckins: 2 },
  "autoresearch-lab": { maxTurns: 14, maxWallTimeMs: 20 * 60_000, maxAdvisorCheckins: 3 },
};

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultBudgetState(kind: BudgetKind = "goal"): BudgetState {
  return {
    kind,
    startedAt: "",
    turns: 0,
    advisorCheckins: 0,
    ...DEFAULT_BUDGETS[kind],
    exhaustedReason: "",
    advisorCheckinReason: "",
    updatedAt: "",
  };
}

export function readBudgetState(ctx: any): BudgetState {
  return readSessionJson(FEATURE, ctx, BUDGET_FILE, defaultBudgetState("goal"));
}

export function writeBudgetState(ctx: any, state: BudgetState): BudgetState {
  const next: BudgetState = { ...state, updatedAt: nowIso() };
  writeSessionJson(FEATURE, ctx, BUDGET_FILE, next);
  return next;
}

export function clearBudgetState(ctx: any): BudgetState {
  return writeBudgetState(ctx, defaultBudgetState("goal"));
}

export function initializeBudgetState(ctx: any, kind: BudgetKind): BudgetState {
  return writeBudgetState(ctx, {
    ...defaultBudgetState(kind),
    startedAt: nowIso(),
  });
}

export function budgetFlowReason(state: BudgetState): string | null {
  if (!state.startedAt) return null;

  if (state.maxTurns > 0 && state.turns >= state.maxTurns) {
    return `max turns reached (${state.turns}/${state.maxTurns})`;
  }

  const startedAt = Date.parse(state.startedAt);
  if (Number.isFinite(startedAt) && state.maxWallTimeMs > 0) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= state.maxWallTimeMs) {
      return `max wall time reached (${Math.round(elapsedMs / 60_000)}m/${Math.round(state.maxWallTimeMs / 60_000)}m)`;
    }
  }

  return state.exhaustedReason ? state.exhaustedReason : null;
}

export function advisorCheckinReason(state: BudgetState): string | null {
  if (state.maxAdvisorCheckins > 0 && state.advisorCheckins >= state.maxAdvisorCheckins) {
    return `max advisor check-ins reached (${state.advisorCheckins}/${state.maxAdvisorCheckins})`;
  }
  return state.advisorCheckinReason ? state.advisorCheckinReason : null;
}

export function recordBudgetTurn(ctx: any): BudgetState {
  const current = readBudgetState(ctx);
  if (!current.startedAt) return current;
  const next: BudgetState = {
    ...current,
    turns: current.turns + 1,
  };
  const reason = budgetFlowReason(next);
  if (reason) next.exhaustedReason = reason;
  return writeBudgetState(ctx, next);
}

export function recordAdvisorCheckin(ctx: any): BudgetState {
  const current = readBudgetState(ctx);
  if (!current.startedAt) return current;
  const next: BudgetState = {
    ...current,
    advisorCheckins: current.advisorCheckins + 1,
  };
  const reason = advisorCheckinReason(next);
  if (reason) next.advisorCheckinReason = reason;
  return writeBudgetState(ctx, next);
}

export function budgetStatus(state: BudgetState): string {
  if (!state.startedAt) return "budget off";
  const flow = budgetFlowReason(state);
  const advisor = advisorCheckinReason(state);
  const startedAt = Date.parse(state.startedAt);
  const age = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
  const ageText = `${Math.round(age / 60_000)}m`;
  const flowText = `turns=${state.turns}/${state.maxTurns}, age=${ageText}/${Math.round(state.maxWallTimeMs / 60_000)}m`;
  const advisorText = `advisor=${state.advisorCheckins}/${state.maxAdvisorCheckins}`;
  const exhausted = flow ? `, flow=${flow}` : "";
  const advisorExhausted = advisor ? `, advisor=${advisor}` : "";
  return `${state.kind} budget: ${flowText}, ${advisorText}${exhausted}${advisorExhausted}`;
}


