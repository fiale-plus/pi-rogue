import { readText } from "./internal.js";
import type { BoardFlightRecord } from "./board-flight-recorder.js";
import type { BoardShadowState } from "./board-shadow.js";

export function loadBoardFlightRecords(filePath: string, limit = 20): BoardFlightRecord[] {
  const text = readText(filePath, "");
  if (!text.trim()) return [];
  const rows: BoardFlightRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<BoardFlightRecord>;
      if (parsed && parsed.schema === "pi-rogue.advisor-board.flight.v1") rows.push(parsed as BoardFlightRecord);
    } catch {
      // skip malformed lines
    }
  }
  return rows.slice(-limit).reverse();
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function summaryLine(record: BoardFlightRecord): string {
  const risks = record.riskTypes.join(", ") || "none";
  const evidence = record.evidencePointers.slice(0, 3).join(", ") || "none";
  return `${record.decisionId} · ${record.decision}${record.decision === "would_whisper" ? `:${record.riskSeverities[0] || "note"}` : ""} · risks=${risks} · evidence=${evidence}`;
}

export function formatBoardFlightWhy(record?: BoardFlightRecord, shadowState?: BoardShadowState): string {
  if (!record) {
    return [
      "Board why:",
      "No board flight record yet.",
      shadowState?.lastDecision ? `Last shadow decision: ${shadowState.lastDecision.action}` : "Last shadow decision: none",
    ].join("\n");
  }

  const reason = record.decision === "silent"
    ? "No active risks reached the whisper threshold."
    : record.decision === "ledger_update"
      ? "A repeated or low-signal risk was recorded in the ledger only; no fresh user-facing note was emitted."
      : `Fresh ${record.riskSeverities[0] || "note"} risk(s) crossed the whisper threshold.`;

  return [
    "Board why:",
    `Decision: ${record.decision}${record.decision === "would_whisper" ? `:${record.riskSeverities[0] || "note"}` : ""}`,
    `Reason: ${reason}`,
    `Risks: ${record.riskTypes.join(", ") || "none"}`,
    `Evidence: ${record.evidencePointers.slice(0, 5).join(", ") || "none"}`,
    `Latency: ${record.latencyMs}ms · Cost: ${formatCost(record.budget.estimatedCostUsd || 0)} · Visibility: ${record.visibleToUser ? "visible" : "shadow-only"}`,
  ].join("\n");
}

export function formatBoardFlightStatus(records: BoardFlightRecord[], shadowState?: BoardShadowState): string {
  const total = records.length;
  const visible = records.filter((record) => record.visibleToUser).length;
  const silent = records.filter((record) => record.decision === "silent").length;
  const ledgerUpdate = records.filter((record) => record.decision === "ledger_update").length;
  const whisper = records.filter((record) => record.decision === "would_whisper").length;
  const avgLatency = total > 0 ? Math.round(records.reduce((sum, record) => sum + record.latencyMs, 0) / total) : 0;
  const totalCost = records.reduce((sum, record) => sum + (record.budget.estimatedCostUsd || 0), 0);
  const last = records[0];
  return [
    "Board telemetry:",
    `Decisions: ${total} | Visible: ${visible} | Silent: ${silent} | Ledger updates: ${ledgerUpdate} | Would whisper: ${whisper}`,
    `Latency: avg ${avgLatency}ms${last ? ` · last ${last.latencyMs}ms` : ""} · Estimated cost: ${formatCost(totalCost)}`,
    last ? `Last: ${summaryLine(last)}` : "Last: none",
    shadowState?.lastDecision ? `Shadow state: ${shadowState.lastDecision.action}${shadowState.lastSuppressedRiskIds?.length ? ` · suppressed ${shadowState.lastSuppressedRiskIds.length}` : ""}` : "Shadow state: none",
  ].join("\n");
}

export function formatBoardFlightReport(records: BoardFlightRecord[], shadowState?: BoardShadowState): string {
  const recent = records.slice(0, 5).map((record) => `- ${record.at} · ${summaryLine(record)} · ${record.latencyMs}ms`);
  return [
    formatBoardFlightStatus(records, shadowState),
    "",
    "Recent decisions:",
    ...(recent.length > 0 ? recent : ["- none"]),
  ].join("\n");
}
