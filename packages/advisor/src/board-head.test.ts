import { describe, expect, it } from "vitest";
import { buildBoardLedger, decideBoardAction, type BoardEvent } from "./board.js";
import {
  buildHeadOfBoardRequest,
  callHeadOfBoardAdapter,
  defaultHeadOfBoardConfig,
  mergeHeadOfBoardRisks,
  normalizeHeadOfBoardConfig,
  shouldEscalateToHeadOfBoard,
} from "./board-head.js";

function ledgerFrom(events: BoardEvent[]) {
  return buildBoardLedger([
    { type: "session", id: "s1", repo: "fiale-plus/pi-rogue", branch: "main" },
    ...events,
  ]);
}

describe("head-of-board adapter", () => {
  it("is disabled by default and does not call the advisor", async () => {
    const ledger = ledgerFrom([{ type: "tool_failure", tool: "bash", key: "npm-test", message: "npm test failed", turn: 3 }]);
    const decision = decideBoardAction(ledger);
    let calls = 0;

    const result = await callHeadOfBoardAdapter(defaultHeadOfBoardConfig(), { ledger, decision, question: "What should we do?" }, async () => {
      calls += 1;
      return { text: "nope", model: "test" };
    });

    expect(result.skipped).toBe("disabled");
    expect(result.accounting.headOfBoardCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("skips non-material decisions even when enabled", async () => {
    const ledger = ledgerFrom([{ type: "turn", turn: 2, progress: true }]);
    const decision = decideBoardAction(ledger);
    const config = { ...defaultHeadOfBoardConfig(), mode: "enabled" as const };
    let calls = 0;

    expect(shouldEscalateToHeadOfBoard(config, { ledger, decision, question: "Anything to escalate?" })).toBe(false);

    const result = await callHeadOfBoardAdapter(config, { ledger, decision, question: "Anything to escalate?" }, async () => {
      calls += 1;
      return { text: "should not happen", model: "test-head" };
    });

    expect(result.skipped).toBe("not_material");
    expect(result.accounting.headOfBoardCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("gates calls to material board decisions and counts them separately", async () => {
    const ledger = ledgerFrom([
      { type: "file_changed", path: "packages/advisor/src/extension.ts", turn: 5 },
      { type: "turn", turn: 9, progress: false },
    ]);
    const decision = decideBoardAction(ledger);
    const config = { ...defaultHeadOfBoardConfig(), mode: "enabled" as const };

    expect(shouldEscalateToHeadOfBoard(config, { ledger, decision, question: "Is this ready to merge?" })).toBe(true);

    const result = await callHeadOfBoardAdapter(config, { ledger, decision, question: "Is this ready to merge?" }, async (systemPrompt, messages, options) => {
      expect(systemPrompt).toContain("read-only");
      expect(messages[0]?.content).toContain("board_ledger");
      expect(options.maxTokens).toBe(config.maxTokens);
      return { text: "Validate before merge.", model: "test-head" };
    });

    expect(result.skipped).toBeUndefined();
    expect(result.response?.text).toBe("Validate before merge.");
    expect(result.accounting).toEqual({ headOfBoardCalls: 1, navigatorCalls: 0 });
    expect(result.request?.constraints).toEqual({ readOnly: true, mutatingTools: [], rawTranscript: false, episodic: true });
  });

  it("passes compact promoted evidence, not stale transcript-era failures", () => {
    const ledger = ledgerFrom([
      { type: "tool_failure", tool: "bash", key: "npm-test", message: "npm test failed before terminal validation", turn: 2 },
      { type: "validation", command: "npm test", exitCode: 0, status: "green", terminal: true, turn: 4 },
      { type: "file_changed", path: "packages/advisor/src/board-head.ts", turn: 6 },
    ]);
    const decision = decideBoardAction(ledger);
    const request = buildHeadOfBoardRequest({ ledger, decision, question: "Review escalation?" }, { ...defaultHeadOfBoardConfig(), mode: "enabled" });
    const promotedPayload = JSON.stringify({ ledger: request.ledger, message: request.messages[0]?.content });

    expect(request.ledger.evidenceEpochs.map((item) => item.summary)).toEqual(["npm test exited 0"]);
    expect(promotedPayload).not.toContain("npm test failed before terminal validation");
    expect(promotedPayload).not.toContain("raw transcript");
    expect(request.messages[0]?.content).toContain("decision_needed");
  });

  it("preserves promoted shadow risks when rebuilding a head-of-board ledger", () => {
    const ledger = ledgerFrom([{ type: "turn", turn: 3, progress: true }]);
    const risk = { id: "repeated_failure:npm-test", type: "repeated_failure" as const, severity: "important" as const, evidence: "npm test failed repeatedly", evidencePointers: ["failure:npm-test"] };
    const request = buildHeadOfBoardRequest({
      ledger: mergeHeadOfBoardRisks(ledger, [risk]),
      decision: { action: "would_whisper", severity: "important", reason: "npm test failed repeatedly", riskIds: ["repeated_failure:npm-test"] },
      question: "What should we do?",
    });

    expect(request.ledger.openRisks.map((item) => item.id)).toContain("repeated_failure:npm-test");
  });

  it("treats rate-limit sentinels as skipped non-calls", async () => {
    const ledger = ledgerFrom([{ type: "file_changed", path: "packages/advisor/src/board-head.ts", turn: 4 }]);
    const config = { ...defaultHeadOfBoardConfig(), mode: "enabled" as const };
    const result = await callHeadOfBoardAdapter(config, { ledger, decision: decideBoardAction(ledger), question: "What next?", reason: "user_request" }, async () => ({ text: "rate limited", model: "none", rateLimited: true }));

    expect(result.skipped).toBe("rate_limited");
    expect(result.accounting.headOfBoardCalls).toBe(0);
  });

  it("sanitizes embedded decision fields before prompting", () => {
    const ledger = ledgerFrom([{ type: "file_changed", path: "packages/advisor/src/board-head.ts", turn: 4 }]);
    const request = buildHeadOfBoardRequest({
      ledger,
      decision: { action: "would_whisper", severity: "important", reason: "rerun with Authorization: Bearer abcdef1234567890 token=abcd1234 AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP", riskIds: ["risk:token=abcd1234"] },
      question: "Assess release readiness with MY_SECRET=shhhhhhh",
    });
    const payload = JSON.stringify({ content: request.messages[0]?.content, escalation: request.escalation });

    expect(payload).not.toContain("abcd1234");
    expect(payload).not.toContain("abcdef1234567890");
    expect(payload).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(payload).not.toContain("shhhhhhh");
    expect(payload).toContain("[secret]");
  });

  it("honors zero optional compaction limits", () => {
    const ledger = ledgerFrom([
      { type: "tool_failure", tool: "bash", key: "npm-test", message: "npm test failed", turn: 2 },
      { type: "subagent_return", id: "s", role: "reviewer", topic: "tests", verdict: "red", summary: "needs tests", turn: 3 },
    ]);
    const request = buildHeadOfBoardRequest({ ledger, decision: decideBoardAction(ledger), question: "What next?" }, { ...defaultHeadOfBoardConfig(), maxFailures: 0, maxSubagents: 0 });

    expect(request.ledger.failures).toEqual([]);
    expect(request.ledger.specialistFindings).toEqual([]);
  });

  it("normalizes config fail-closed", () => {
    expect(normalizeHeadOfBoardConfig({ mode: "enabled", maxTokens: 99999, reasoning: "high" })).toMatchObject({ mode: "enabled", maxTokens: 4000, reasoning: "high" });
    expect(normalizeHeadOfBoardConfig({ mode: "live", maxEvidence: -5, reasoning: "max" })).toMatchObject({ mode: "off", maxEvidence: 1, reasoning: "medium" });
    expect(normalizeHeadOfBoardConfig(undefined).mode).toBe("off");
  });
});
