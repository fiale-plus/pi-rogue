import { describe, expect, it } from "vitest";
import { buildBoardLedger } from "./board.js";
import { defaultBoardRiskLifecycleState, updateBoardRiskLifecycle } from "./board-risk-lifecycle.js";

const repeatedFailureEvents = [
  { type: "session", id: "s1", repo: "fiale-plus/pi-rogue" },
  { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 1 },
  { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 2 },
  { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 3 },
] as const;

const missingValidationEvents = [
  { type: "session", id: "s2", repo: "fiale-plus/pi-rogue" },
  { type: "validation", command: "npm test", exitCode: 0, status: "green", turn: 1 },
  { type: "file_changed", path: "packages/advisor/src/board.ts", turn: 4 },
] as const;

const missingValidationRecoveredEvents = [
  { type: "session", id: "s2", repo: "fiale-plus/pi-rogue" },
  { type: "validation", command: "npm test", exitCode: 0, status: "green", turn: 1, terminal: true },
  { type: "file_changed", path: "packages/advisor/src/board.ts", turn: 4 },
  { type: "validation", command: "npm test", exitCode: 0, status: "green", terminal: true, turn: 5 },
] as const;

describe("board risk lifecycle", () => {
  it("suppresses repeated risks until new evidence appears", () => {
    const ledger = buildBoardLedger([...repeatedFailureEvents]);
    const first = updateBoardRiskLifecycle(defaultBoardRiskLifecycleState(), ledger, ledger.risks);
    const second = updateBoardRiskLifecycle(first.state, ledger, ledger.risks);

    const fingerprint = Object.keys(first.state.entries)[0];

    expect(first.visibleRisks.map((risk) => risk.id)).toEqual(["repeated_failure:edit-string-not-found"]);
    expect(second.visibleRisks).toHaveLength(0);
    expect(second.suppressedRiskIds).toEqual([fingerprint]);
    expect(second.state.entries[fingerprint].status).toBe("accepted-until-new-evidence");
  });

  it("marks old risk fingerprints stale after newer green evidence and reopens on new evidence", () => {
    const base = buildBoardLedger([...missingValidationEvents]);
    const recovered = buildBoardLedger([...missingValidationRecoveredEvents]);

    const first = updateBoardRiskLifecycle(defaultBoardRiskLifecycleState(), base, base.risks);
    const second = updateBoardRiskLifecycle(first.state, recovered, recovered.risks);
    const third = updateBoardRiskLifecycle(second.state, base, base.risks);

    const fingerprint = Object.keys(first.state.entries)[0];
    const visibleRiskId = first.visibleRisks[0]?.id;
    expect(visibleRiskId).toBe("missing_validation:4");
    expect(second.staleRiskIds).toEqual([fingerprint]);
    expect(second.state.entries[fingerprint].status).toBe("stale");
    expect(third.reopenedRiskIds).toEqual([fingerprint]);
    expect(third.visibleRisks.map((risk) => risk.id)).toEqual(["missing_validation:4"]);
    expect(third.state.entries[fingerprint].status).toBe("reopened");
  });
});
