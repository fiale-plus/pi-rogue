import { describe, expect, it } from "vitest";
import {
  applyBoardTelemetryWritePlan,
  boardEventsFromAdvisorState,
  defaultBoardShadowState,
  formatBoardShadowStatus,
  normalizeBoardShadowConfig,
  planBoardTelemetryWrite,
  runBoardShadowDecision,
  updateBoardShadowState,
  type BoardShadowConfig,
} from "./board-shadow.js";

describe("board shadow", () => {
  it("normalizes board shadow config fail-closed", () => {
    expect(normalizeBoardShadowConfig({ mode: "shadow" })).toEqual({ mode: "shadow" });
    expect(normalizeBoardShadowConfig({ mode: "auto" })).toEqual({ mode: "off" });
    expect(normalizeBoardShadowConfig(undefined)).toEqual({ mode: "off" });
  });

  it("builds compact board events from advisor session evidence", () => {
    const events = boardEventsFromAdvisorState({
      sessionId: "s1",
      repo: "fiale-plus/pi-rogue",
      branch: "main",
      turns: 7,
      evidenceLedger: [{ kind: "validation", command: "npm test", result: "pass", exitCode: 0, timestamp: "2026-06-27T00:00:00Z" }],
    });

    expect(events.map((event) => event.type)).toEqual(["session", "turn", "validation"]);
    expect(JSON.stringify(events)).not.toContain("raw transcript");
  });

  it("extracts changed files and failures from compact tool results", () => {
    const events = boardEventsFromAdvisorState({
      turns: 4,
      toolResults: [
        { toolName: "edit", input: { path: "packages/advisor/src/extension.ts", oldText: "secret raw transcript", newText: "replacement" } },
        { toolName: "bash", command: "npm test", exitCode: 1, stderr: "expected true to be false" },
      ],
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file_changed", path: "packages/advisor/src/extension.ts" }),
      expect.objectContaining({ type: "tool_failure", tool: "bash" }),
    ]));
    expect(JSON.stringify(events)).not.toContain("secret raw transcript");
  });

  it("redacts raw tool output from repeated-failure risks", () => {
    const result = runBoardShadowDecision({
      turns: 5,
      toolResults: [
        { toolName: "bash", command: "npm test -H 'Authorization: Bearer abcdefghijklmnop'", exitCode: 1, details: { stderr: "raw transcript SECRET_TOKEN_12345", log: "raw transcript SECRET_TOKEN_12345" } },
        { toolName: "bash", command: "npm test -H 'Authorization: Bearer abcdefghijklmnop'", exitCode: 1, details: ["raw transcript SECRET_TOKEN_12345"], output: "raw transcript SECRET_TOKEN_12345" },
        { toolName: "bash", command: "npm test -H 'Authorization: Bearer abcdefghijklmnop'", exitCode: 1, content: [{ type: "text", text: "raw transcript SECRET_TOKEN_12345" }] },
      ],
    });

    expect(result.risks.map((risk) => risk.type)).toContain("repeated_failure");
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_12345");
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(result)).not.toContain("raw transcript");
  });

  it("does not mark current-turn validation as stale behind current tool changes", () => {
    const result = runBoardShadowDecision({
      turns: 10,
      toolResults: [
        { toolName: "edit", input: { path: "packages/advisor/src/extension.ts" } },
        { toolName: "bash", command: "npm test", exitCode: 0 },
      ],
    });

    expect(result.risks.map((risk) => risk.type)).not.toContain("missing_validation");
  });

  it("preserves same-batch validation-before-edit ordering", () => {
    const result = runBoardShadowDecision({
      turns: 10,
      toolResults: [
        { toolName: "bash", command: "npm test", exitCode: 0 },
        { toolName: "edit", input: { path: "packages/advisor/src/extension.ts" } },
      ],
    });

    expect(result.risks.map((risk) => risk.type)).toContain("missing_validation");
  });

  it("reads safe command and exit metadata from tool details", () => {
    const result = runBoardShadowDecision({
      turns: 10,
      toolResults: [
        { toolName: "edit", details: { path: "packages/advisor/src/extension.ts" } },
        { toolName: "bash", details: { command: "npm test", exitCode: 0, stderr: "raw transcript SECRET_TOKEN_12345" } },
      ],
    });

    expect(result.risks.map((risk) => risk.type)).not.toContain("missing_validation");
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_12345");
    expect(JSON.stringify(result)).not.toContain("raw transcript");
  });

  it("uses board-local pending files and clears them from validation content", () => {
    const first = runBoardShadowDecision({
      turns: 10,
      toolResults: [{ toolName: "edit", input: { path: "packages/advisor/src/extension.ts" } }],
    });
    const second = runBoardShadowDecision({
      turns: 11,
      toolResults: [{ toolName: "bash", exitCode: 0, content: [{ type: "text", text: "Test Files 3 passed (3)" }] }],
    }, first.state);

    expect(first.state.pendingFiles).toContain("packages/advisor/src/extension.ts");
    expect(second.risks.map((risk) => risk.type)).not.toContain("missing_validation");
    expect(second.state.pendingFiles).toEqual([]);
  });

  it("drops alternate edit payload field names from failure summaries", () => {
    const result = runBoardShadowDecision({
      turns: 4,
      toolResults: [
        { toolName: "edit", isError: true, input: { path: "packages/advisor/src/extension.ts", oldString: "raw transcript SECRET_TOKEN_12345", new_string: "raw transcript SECRET_TOKEN_12345" } },
      ],
    });

    expect(JSON.stringify(result.events)).toContain("edit failed");
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_12345");
    expect(JSON.stringify(result)).not.toContain("raw transcript");
  });

  it("does not treat unrelated successful package commands as validation", () => {
    const result = runBoardShadowDecision({
      turns: 10,
      toolResults: [
        { toolName: "edit", input: { path: "packages/advisor/src/extension.ts" } },
        { toolName: "bash", command: "npm install", exitCode: 0 },
        { toolName: "bash", command: "tsx scripts/select-board-fixtures.ts", exitCode: 0 },
      ],
    });

    expect(result.risks.map((risk) => risk.type)).toContain("missing_validation");
  });

  it("carries pending changed files into later shadow decisions", () => {
    const result = runBoardShadowDecision({
      turns: 11,
      pendingFiles: ["packages/advisor/src/extension.ts"],
      evidenceLedger: [{ kind: "validation", command: "npm test", result: "pass", exitCode: 0 }],
      toolResults: [{ toolName: "bash", command: "git status", exitCode: 0 }],
    });

    expect(result.risks.map((risk) => risk.type)).toContain("missing_validation");
  });

  it("preserves evidence ordering for stale-evidence detection", () => {
    const result = runBoardShadowDecision({
      turns: 12,
      evidenceLedger: [
        { kind: "validation", command: "npm test", result: "fail", exitCode: 1, timestamp: "2026-06-27T00:00:00Z" },
        { kind: "validation", command: "npm test", result: "pass", exitCode: 0, timestamp: "2026-06-27T00:01:00Z" },
      ],
    });

    expect(result.risks.map((risk) => risk.type)).toContain("stale_evidence");
  });

  it("runs deterministic shadow decisions without model/specialist actions", () => {
    const result = runBoardShadowDecision({
      sessionId: "s2",
      turns: 3,
      evidenceLedger: [{ kind: "validation", command: "npm test", result: "pass", exitCode: 0 }],
      toolResults: [{ toolName: "edit", input: { path: "A.ts" } }],
    }, undefined, new Date("2026-06-27T00:00:00Z"));

    expect(result.decision).toMatchObject({ action: "would_whisper", severity: "important" });
    expect(result.risks.map((risk) => risk.type)).toContain("missing_validation");
    expect(result.state.counters.wouldWhisper).toBe(1);
    expect(result.state.lastAt).toBe("2026-06-27T00:00:00.000Z");
  });

  it("accumulates counters and formats status", () => {
    const config: BoardShadowConfig = { mode: "shadow" };
    const state = updateBoardShadowState(defaultBoardShadowState(), { action: "ledger_update", riskIds: ["r1"] }, [{
      id: "r1",
      type: "no_progress",
      severity: "note",
      evidence: "stalled",
      evidencePointers: ["turn:6"],
    }], new Date("2026-06-27T00:00:00Z"));

    expect(state.counters).toMatchObject({ runs: 1, ledgerUpdate: 1, byRisk: { no_progress: 1 } });
    expect(formatBoardShadowStatus(config, state)).toContain("Board shadow: shadow");
    expect(formatBoardShadowStatus(config, state)).toContain("no model calls");
  });

  it("suppresses writer repeats for identical ledger updates", () => {
    const evidenceLedger = [
      { kind: "validation" as const, command: "npm test", result: "fail" as const, exitCode: 1, timestamp: "2026-06-27T00:00:00Z" },
      { kind: "validation" as const, command: "npm test", result: "pass" as const, exitCode: 0, timestamp: "2026-06-27T00:01:00Z" },
    ];
    const first = runBoardShadowDecision({ turns: 12, evidenceLedger });
    const firstPlan = planBoardTelemetryWrite(undefined, first.decision, first.risks);
    const firstWrittenState = applyBoardTelemetryWritePlan(first.state, firstPlan);
    const second = runBoardShadowDecision({ turns: 13, evidenceLedger }, firstWrittenState);
    const secondPlan = planBoardTelemetryWrite(firstWrittenState, second.decision, second.risks);
    const secondWrittenState = applyBoardTelemetryWritePlan(second.state, secondPlan);
    const third = runBoardShadowDecision({ turns: 14, evidenceLedger }, secondWrittenState);
    const thirdPlan = planBoardTelemetryWrite(secondWrittenState, third.decision, third.risks);

    expect(first.decision.action).toBe("would_whisper");
    expect(firstPlan.write).toBe(true);
    expect(second.decision.action).toBe("ledger_update");
    expect(secondPlan.write).toBe(true);
    expect(third.decision.action).toBe("ledger_update");
    expect(third.risks.map((risk) => risk.type)).toEqual(["stale_evidence"]);
    expect(thirdPlan).toMatchObject({ write: false, reason: "same-ledger-update", suppressedCount: 1 });
  });

  it("still writes changed ledger updates after a suppressed repeat", () => {
    const risk = {
      id: "r1",
      type: "no_progress" as const,
      severity: "note" as const,
      evidence: "stalled",
      evidencePointers: ["turn:6"],
    };
    const first = updateBoardShadowState(defaultBoardShadowState(), { action: "ledger_update", riskIds: ["r1"] }, [risk]);
    const firstPlan = planBoardTelemetryWrite(undefined, { action: "ledger_update", riskIds: ["r1"] }, [risk]);
    const firstWrittenState = applyBoardTelemetryWritePlan(first, firstPlan);
    const repeatPlan = planBoardTelemetryWrite(firstWrittenState, { action: "ledger_update", riskIds: ["r1"] }, [risk]);
    const changedPlan = planBoardTelemetryWrite(applyBoardTelemetryWritePlan(firstWrittenState, repeatPlan), { action: "ledger_update", riskIds: ["r2"] }, [{ ...risk, id: "r2", evidencePointers: ["turn:7"] }]);

    expect(repeatPlan.write).toBe(false);
    expect(changedPlan.write).toBe(true);
  });
});
