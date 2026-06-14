import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  detectAssistantRepetition,
  looksLikeNoProgressTurn,
  normalizeTurn,
  recordAssistantTurn,
  registerNoveltyGuard,
  turnSimilarity,
  type RepetitionGuardState,
} from "./novelty-guard.js";
import { readText, sessionFile, writeText } from "./internal.js";

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

  it("identifies planning-only no-progress turns", () => {
    expect(looksLikeNoProgressTurn("I will think through the approach and plan the next steps.")).toBe(true);
    expect(looksLikeNoProgressTurn("I ran npm test and found one failing assertion.")).toBe(false);
  });

  it("tracks bounded no-progress only while orchestration is active", () => {
    const base: RepetitionGuardState = { recentAssistantTurns: [] };
    const first = recordAssistantTurn(base, "I will think through the approach and plan the next step.", { activeOrchestration: true });
    const second = recordAssistantTurn(first, "I will think through the approach and plan the next step.", { activeOrchestration: true });
    const third = recordAssistantTurn(second, "I will think through the approach and plan the next step.", { activeOrchestration: true });

    expect(third.noProgress?.count).toBe(3);

    const inactive = recordAssistantTurn(base, "I will think through the approach and plan the next step.", { activeOrchestration: false });
    expect(inactive.noProgress).toBeUndefined();
  });

  it("does not inject stale no-progress recovery after orchestration is inactive", async () => {
    const handlers: Record<string, (event: any, ctx: any) => Promise<any> | any> = {};
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<any> | any) => { handlers[name] = handler; },
    } as any;
    const sessionPath = `/tmp/pi-rogue-novelty-${randomUUID()}.jsonl`;
    const ctx = {
      sessionManager: { getSessionFile: () => sessionPath },
      ui: { notify: () => undefined },
    };
    writeText(sessionFile("orchestration", ctx, "repetition-guard.json"), `${JSON.stringify({
      recentAssistantTurns: [],
      noProgress: { at: new Date().toISOString(), count: 3, text: "I will plan the next step.", reason: "test" },
    })}\n`);

    registerNoveltyGuard(pi);
    const result = await handlers.before_agent_start?.({ systemPrompt: "base" }, ctx);

    expect(result.systemPrompt).toBe("base");
    expect(JSON.parse(readText(sessionFile("orchestration", ctx, "repetition-guard.json"))).noProgress).toBeUndefined();
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
