import { describe, expect, it } from "vitest";
import {
  detectAssistantRepetition,
  evaluateNoveltyGuard,
  isStatusConfirmation,
  looksTruncatedPrompt,
  recordAssistantTurn,
  recordUserTurn,
  turnSimilarity,
  type NoveltyGuardState,
} from "./novelty-guard.js";

function stateWithExchange(user: string, assistant: string): NoveltyGuardState {
  return recordAssistantTurn(recordUserTurn({ recentUserTurns: [], recentAssistantTurns: [] }, user), assistant);
}

describe("novelty guard", () => {
  it("detects near-duplicate status prompts after a status confirmation", () => {
    const state = stateWithExchange(
      "Repo-side autoresearch appears closed with promoted model, runtime sync, committed eval artifacts, and closeout marker.",
      "Yes — repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains.",
    );

    const decision = evaluateNoveltyGuard(
      "Autoresearch appears repo-side complete and properly closed, with promoted/runtime model paths and eval artifacts noted.",
      state,
    );

    expect(decision.action).toBe("duplicate");
    if (decision.action === "duplicate") expect(decision.similarity).toBeGreaterThan(0.72);
  });

  it("does not block a similar prompt when it asks for a concrete new action", () => {
    const state = stateWithExchange(
      "Repo-side autoresearch appears closed with promoted model, runtime sync, committed eval artifacts, and closeout marker.",
      "Yes — repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains.",
    );

    const decision = evaluateNoveltyGuard(
      "Repo-side autoresearch is closed; now draft the rollout and rollback commands for release handoff.",
      state,
    );

    expect(decision.action).toBe("continue");
  });

  it("asks for clarification on truncated prompts instead of inferring the missing request", () => {
    expect(looksTruncatedPrompt("The repo-side model promotion looks done, but the closeout does not clearly confirm that the benc")).toBe(true);

    const decision = evaluateNoveltyGuard(
      "The repo-side model promotion looks done, but the closeout does not clearly confirm that the benc",
      { recentUserTurns: [], recentAssistantTurns: [] },
    );

    expect(decision.action).toBe("clarify_truncated");
  });

  it("detects repeated assistant status confirmations as loop fuel", () => {
    expect(isStatusConfirmation("Yes — repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains.")).toBe(true);

    const base: NoveltyGuardState = { recentUserTurns: [], recentAssistantTurns: [] };
    const withFirst = recordAssistantTurn(recordUserTurn(base, "Autoresearch appears complete repo-side with promoted model and eval artifacts."), "Yes — repo-side autoresearch is verified closed. Only optional external rollout remains.");
    const withSecond = recordAssistantTurn(recordUserTurn(withFirst, "Repo-side autoresearch appears complete with promoted model/runtime and committed eval artifacts."), "Yes — repo-side autoresearch is complete. Only optional CI smoke remains.");

    const decision = evaluateNoveltyGuard(
      "Repo-side autoresearch appears closed with promoted runtime/model and eval artifacts committed.",
      withSecond,
    );

    expect(decision.action).toBe("duplicate");
  });

  it("keeps similarity high for close paraphrases", () => {
    const similarity = turnSimilarity(
      "Repo-side autoresearch appears complete with promoted model, runtime sync, and eval artifacts.",
      "Autoresearch is complete on the repo side with synced runtime/model and committed evaluation artifacts.",
    );

    expect(similarity).toBeGreaterThan(0.72);
  });

  it("detects repeated assistant output even without a repeated user prompt", () => {
    const base: NoveltyGuardState = { recentUserTurns: [], recentAssistantTurns: [] };
    const first = recordAssistantTurn(base, "Now let me build the session-flow analyzer and workflow clustering pipeline.");
    const second = recordAssistantTurn(first, "Now let me build the session-flow analyzer and workflow clustering pipeline.");
    const third = recordAssistantTurn(second, "Now let me build the session-flow analyzer and workflow clustering pipeline.");

    const repeat = detectAssistantRepetition(third);

    expect(repeat?.count).toBe(3);
    expect(third.assistantRepeat?.text).toContain("session-flow analyzer");
  });
});
