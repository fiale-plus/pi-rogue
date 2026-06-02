import { describe, expect, it } from "vitest";
import {
  detectAssistantRepetition,
  normalizeTurn,
  recordAssistantTurn,
  turnSimilarity,
  type RepetitionGuardState,
} from "./novelty-guard.js";

describe("repetition guard", () => {
  it("normalizes noisy assistant text", () => {
    expect(normalizeTurn("Run `npm test` now. https://example.test")).toBe("run now url");
  });

  it("keeps similarity high for close paraphrases", () => {
    const similarity = turnSimilarity(
      "Inspect current state and apply the smallest missing delta before retrying.",
      "Inspect the current state, then apply only the smallest missing change before retrying.",
    );

    expect(similarity).toBeGreaterThan(0.8);
  });

  it("detects repeated assistant output", () => {
    const base: RepetitionGuardState = { recentAssistantTurns: [] };
    const first = recordAssistantTurn(base, "Now let me build the session-flow analyzer and workflow clustering pipeline.");
    const second = recordAssistantTurn(first, "Now let me build the session-flow analyzer and workflow clustering pipeline.");
    const third = recordAssistantTurn(second, "Now let me build the session-flow analyzer and workflow clustering pipeline.");

    const repeat = detectAssistantRepetition(third);

    expect(repeat?.count).toBe(3);
    expect(third.assistantRepeat?.text).toContain("session-flow analyzer");
  });
});
