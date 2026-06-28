import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendBoardFlightRecord, buildBoardFlightRecord } from "./board-flight-recorder.js";
import { buildBoardLedger, decideBoardAction } from "./board.js";

const staleEvidenceEvents = [
  { type: "session", id: "s1", repo: "fiale-plus/pi-rogue", worktree: "/tmp/wt" },
  { type: "validation", command: "npm test", exitCode: 1, status: "red", turn: 2 },
  { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 3 },
  { type: "validation", command: "npm test", exitCode: 0, status: "green", terminal: true, turn: 8 },
] as const;

describe("board flight recorder", () => {
  it("builds stable, compact decision records without raw transcript data", () => {
    const ledger = buildBoardLedger([...staleEvidenceEvents]);
    const decision = decideBoardAction(ledger);

    const recordA = buildBoardFlightRecord({ ledger, decision, latencyMs: 3, at: "2026-06-27T00:00:00.000Z", source: "turn_end" });
    const recordB = buildBoardFlightRecord({ ledger, decision, latencyMs: 97, at: "2026-06-27T00:01:00.000Z", source: "turn_end" });

    expect(recordA.decisionId).toBe(recordB.decisionId);
    expect(recordA.riskFingerprint).toBe(recordB.riskFingerprint);
    expect(recordA.ledgerHash).toBe(recordB.ledgerHash);
    expect(recordA.visibleToUser).toBe(false);
    expect(recordA.schema).toBe("pi-rogue.advisor-board.flight.v1");
    expect(recordA.evidencePointers).toEqual(expect.arrayContaining(["validation:3", "validation:1", "failure:edit:string-not-found:1"]));
    expect(JSON.stringify(recordA)).not.toContain("raw transcript");
  });

  it("appends JSONL flight records to a compact telemetry file", () => {
    const ledger = buildBoardLedger([...staleEvidenceEvents]);
    const decision = decideBoardAction(ledger);
    const record = buildBoardFlightRecord({ ledger, decision, latencyMs: 1, at: "2026-06-27T00:00:00.000Z", source: "turn_end" });
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-board-flight-"));
    const file = join(dir, "board-flight.jsonl");

    try {
      appendBoardFlightRecord(file, record);
      appendBoardFlightRecord(file, record);

      const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ schema: "pi-rogue.advisor-board.flight.v1", decisionId: record.decisionId });
      expect(JSON.parse(lines[1])).toMatchObject({ schema: "pi-rogue.advisor-board.flight.v1", decisionId: record.decisionId });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
