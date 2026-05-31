import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  advisorCheckinReason,
  budgetFlowReason,
  defaultBudgetState,
  initializeBudgetState,
  readBudgetState,
  recordAdvisorCheckin,
  recordBudgetTurn,
} from "./budget.js";

function fakeCtx(id = randomUUID()) {
  return {
    sessionManager: {
      getSessionFile: () => `/tmp/pi-rogue-budget-test-${id}.jsonl`,
    },
  };
}

describe("orchestration budgets", () => {
  it("sets different defaults for goal and autoresearch", () => {
    expect(defaultBudgetState("goal")).toMatchObject({ maxTurns: 20, maxAdvisorCheckins: 3 });
    expect(defaultBudgetState("autoresearch")).toMatchObject({ maxTurns: 10, maxAdvisorCheckins: 2 });
  });

  it("treats advisor check-ins as a separate cap from the main flow budget", () => {
    const ctx = fakeCtx();
    initializeBudgetState(ctx, "autoresearch");

    let state = readBudgetState(ctx);
    expect(budgetFlowReason(state)).toBeNull();
    expect(advisorCheckinReason(state)).toBeNull();

    state = recordAdvisorCheckin(ctx);
    expect(budgetFlowReason(state)).toBeNull();
    expect(advisorCheckinReason(state)).toBeNull();

    state = recordAdvisorCheckin(ctx);
    expect(budgetFlowReason(state)).toBeNull();
    expect(advisorCheckinReason(state)).toContain("max advisor check-ins reached");
  });

  it("stops the main flow after the turn cap is reached", () => {
    const ctx = fakeCtx();
    initializeBudgetState(ctx, "goal");

    for (let i = 0; i < 20; i++) {
      recordBudgetTurn(ctx);
    }

    const state = readBudgetState(ctx);
    expect(budgetFlowReason(state)).toContain("max turns reached");
    expect(advisorCheckinReason(state)).toBeNull();
  });
});
