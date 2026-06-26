import { describe, expect, it } from "vitest";
import {
  buildBoardLedger,
  decideBoardAction,
  evaluateBoardFixtures,
  type BoardFixture,
} from "./board.js";

const staleEvidenceFixture: BoardFixture = {
  id: "stale-evidence-green-after-red",
  expectedEdgeMoment: "older red validation is superseded by newer terminal green validation",
  expectedRiskTypes: ["stale_evidence"],
  events: [
    { type: "session", id: "s1", repo: "fiale-plus/pi-rogue", branch: "issue217", worktree: "/tmp/wt" },
    { type: "validation", command: "npm test", exitCode: 1, status: "red", turn: 2 },
    { type: "tool_failure", tool: "advisor", key: "old-vitest-failure", message: "Vitest failed", turn: 3 },
    { type: "validation", command: "npm test", exitCode: 0, status: "green", terminal: true, turn: 8 },
  ],
};

const repeatedFailureFixture: BoardFixture = {
  id: "repeated-tool-failure",
  expectedEdgeMoment: "same tool failure repeats three times",
  expectedRiskTypes: ["repeated_failure"],
  events: [
    { type: "session", id: "s2", repo: "fiale-plus/pi-rogue" },
    { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 1 },
    { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 2 },
    { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 3 },
  ],
};

const missingValidationFixture: BoardFixture = {
  id: "changed-files-no-validation",
  expectedEdgeMoment: "files changed after last validation",
  expectedRiskTypes: ["missing_validation"],
  events: [
    { type: "session", id: "s3", repo: "fiale-plus/pi-rogue" },
    { type: "validation", command: "npm test", exitCode: 0, status: "green", turn: 1 },
    { type: "file_changed", path: "packages/advisor/src/board.ts", turn: 4 },
  ],
};

const subagentContradictionFixture: BoardFixture = {
  id: "subagent-contradiction",
  expectedEdgeMoment: "subagents disagree on same topic",
  expectedRiskTypes: ["subagent_contradiction"],
  events: [
    { type: "session", id: "s4", repo: "fiale-plus/pi-rogue" },
    {
      type: "subagent_return",
      id: "reviewer-a",
      role: "reviewer",
      topic: "validation-state",
      verdict: "red",
      summary: "tests are still failing",
      confidence: 0.8,
      turn: 5,
    },
    {
      type: "subagent_return",
      id: "reviewer-b",
      role: "reviewer",
      topic: "validation-state",
      verdict: "green",
      summary: "latest test run is green",
      confidence: 0.9,
      turn: 6,
    },
  ],
};

describe("Advisor Board PoC ledger", () => {
  it("keeps session/worktree metadata and compact evidence", () => {
    const ledger = buildBoardLedger(staleEvidenceFixture.events);

    expect(ledger.session).toEqual({
      id: "s1",
      repo: "fiale-plus/pi-rogue",
      branch: "issue217",
      worktree: "/tmp/wt",
    });
    expect(ledger.evidence.map((item) => item.kind)).toEqual(["validation", "tool_failure", "validation"]);
    expect(JSON.stringify(ledger)).not.toContain("raw transcript");
  });

  it("detects stale red evidence after newer terminal green evidence", () => {
    const ledger = buildBoardLedger(staleEvidenceFixture.events);

    expect(ledger.risks).toMatchObject([
      {
        type: "stale_evidence",
        severity: "important",
      },
    ]);
    expect(decideBoardAction(ledger)).toMatchObject({ action: "would_whisper", severity: "important" });
  });

  it("detects repeated failures for the same tool and failure key", () => {
    const ledger = buildBoardLedger(repeatedFailureFixture.events);

    expect(ledger.failures).toMatchObject([{ key: "string-not-found", tool: "edit", count: 3 }]);
    expect(ledger.risks.map((risk) => risk.type)).toContain("repeated_failure");
  });

  it("does not cluster same failure keys across different tools", () => {
    const ledger = buildBoardLedger([
      { type: "tool_failure", tool: "edit", key: "timeout", turn: 1 },
      { type: "tool_failure", tool: "bash", key: "timeout", turn: 2 },
      { type: "tool_failure", tool: "grep", key: "timeout", turn: 3 },
    ]);

    expect(ledger.failures).toHaveLength(3);
    expect(ledger.risks.map((risk) => risk.type)).not.toContain("repeated_failure");
  });

  it("detects missing validation after changed files", () => {
    const ledger = buildBoardLedger(missingValidationFixture.events);

    expect(ledger.changedFiles).toEqual(["packages/advisor/src/board.ts"]);
    expect(ledger.risks.map((risk) => risk.type)).toContain("missing_validation");
  });

  it("detects subagent contradictions when available", () => {
    const ledger = buildBoardLedger(subagentContradictionFixture.events);

    expect(ledger.subagents).toHaveLength(2);
    expect(ledger.risks.map((risk) => risk.type)).toContain("subagent_contradiction");
  });

  it("emits snapshot-testable eval report rows with evidence pointers", () => {
    const report = evaluateBoardFixtures([
      staleEvidenceFixture,
      repeatedFailureFixture,
      missingValidationFixture,
      subagentContradictionFixture,
    ]);

    expect(report).toMatchInlineSnapshot(`
      [
        {
          "decision": "would_whisper",
          "detectedRisk": "stale_evidence",
          "evidencePointer": "validation:3",
          "expectedEdgeMoment": "older red validation is superseded by newer terminal green validation",
          "falseNegativeNotes": "",
          "falsePositiveNotes": "",
          "fixtureId": "stale-evidence-green-after-red",
        },
        {
          "decision": "would_whisper",
          "detectedRisk": "repeated_failure",
          "evidencePointer": "failure:edit:string-not-found",
          "expectedEdgeMoment": "same tool failure repeats three times",
          "falseNegativeNotes": "",
          "falsePositiveNotes": "",
          "fixtureId": "repeated-tool-failure",
        },
        {
          "decision": "would_whisper",
          "detectedRisk": "missing_validation",
          "evidencePointer": "file:packages/advisor/src/board.ts",
          "expectedEdgeMoment": "files changed after last validation",
          "falseNegativeNotes": "",
          "falsePositiveNotes": "",
          "fixtureId": "changed-files-no-validation",
        },
        {
          "decision": "would_whisper",
          "detectedRisk": "subagent_contradiction",
          "evidencePointer": "subagent:reviewer-a",
          "expectedEdgeMoment": "subagents disagree on same topic",
          "falseNegativeNotes": "",
          "falsePositiveNotes": "",
          "fixtureId": "subagent-contradiction",
        },
      ]
    `);
  });
});
