import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoardFlightRecord, appendBoardFlightRecord } from "./board-flight-recorder.js";
import { buildBoardLedger, decideBoardAction } from "./board.js";
import { defaultBoardShadowState } from "./board-shadow.js";
import { formatBoardFlightWhy, formatBoardFlightReport, formatBoardFlightStatus, loadBoardFlightRecords } from "./board-flight-ux.js";

const events = [
  { type: "session", id: "s1", repo: "fiale-plus/pi-rogue", worktree: "/tmp/wt" },
  { type: "validation", command: "npm test", exitCode: 1, status: "red", turn: 2 },
  { type: "tool_failure", tool: "edit", key: "string-not-found", message: "oldText not found", turn: 3 },
  { type: "validation", command: "npm test", exitCode: 0, status: "green", terminal: true, turn: 8 },
] as const;

describe("board flight UX", () => {
  it("explains the latest board decision in plain language", () => {
    const ledger = buildBoardLedger([...events]);
    const decision = decideBoardAction(ledger);
    const record = buildBoardFlightRecord({ ledger, decision, latencyMs: 2, at: "2026-06-27T00:00:00.000Z", source: "turn_end" });

    const text = formatBoardFlightWhy(record, defaultBoardShadowState());
    expect(text).toContain("Board why:");
    expect(text).toContain("Decision:");
    expect(text).toContain("shadow-only");
    expect(text).not.toContain("raw transcript");
  });

  it("loads recent records and summarizes status/report compactly", () => {
    const ledger = buildBoardLedger([...events]);
    const decision = decideBoardAction(ledger);
    const record1 = buildBoardFlightRecord({ ledger, decision, latencyMs: 2, at: "2026-06-27T00:00:00.000Z", source: "turn_end" });
    const record2 = buildBoardFlightRecord({ ledger, decision: { action: "ledger_update", riskIds: [record1.riskIds[0]] }, latencyMs: 4, at: "2026-06-27T00:01:00.000Z", source: "turn_end", visibleToUser: false });
    const record3 = { ...record2, decisionId: "flight:repeat", at: "2026-06-27T00:02:00.000Z", latencyMs: 5 };
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-board-flight-ux-"));
    const file = join(dir, "board-flight.jsonl");

    try {
      appendBoardFlightRecord(file, record1);
      appendBoardFlightRecord(file, record2);
      appendBoardFlightRecord(file, record3);
      const records = loadBoardFlightRecords(file, 10);
      const status = formatBoardFlightStatus(records, defaultBoardShadowState(), { telemetryPath: file });
      const report = formatBoardFlightReport(records, defaultBoardShadowState(), { telemetryPath: file });

      expect(records).toHaveLength(3);
      expect(records[0].decision).toBe("ledger_update");
      expect(status).toContain("Decisions: 3");
      expect(status).toContain("Would whisper: 1");
      expect(status).toContain("Telemetry path:");
      expect(status).toContain("Compaction: 1 repeated record collapsed");
      expect(report).toContain("Posture:");
      expect(report).toContain("Top active risk: stale_evidence:important");
      expect(report).toContain("Evidence hygiene: stale evidence marked");
      expect(report).toContain("Recent compacted decisions:");
      expect(report).toContain("×2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
