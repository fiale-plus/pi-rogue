import { readText, truncate } from "./internal.js";
import type { BoardFlightRecord } from "./board-flight-recorder.js";
import type { BoardShadowState } from "./board-shadow.js";

export interface BoardFlightReportOptions {
  telemetryPath?: string;
}

interface BoardFlightRecordGroup {
  record: BoardFlightRecord;
  count: number;
  firstAt: string;
  lastAt: string;
}

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

function compactKey(record: BoardFlightRecord): string {
  return [
    record.decision,
    record.riskFingerprint,
    [...record.riskIds].sort().join(","),
    [...record.riskTypes].sort().join(","),
    [...record.riskSeverities].sort().join(","),
  ].join("|");
}

function compactRecords(records: BoardFlightRecord[]): BoardFlightRecordGroup[] {
  const groups: BoardFlightRecordGroup[] = [];
  for (const record of records) {
    const previous = groups[groups.length - 1];
    if (previous && compactKey(previous.record) === compactKey(record)) {
      previous.count += 1;
      previous.lastAt = record.at;
    } else {
      groups.push({ record, count: 1, firstAt: record.at, lastAt: record.at });
    }
  }
  return groups;
}

function summaryLine(record: BoardFlightRecord): string {
  const risks = record.riskTypes.join(", ") || "none";
  const evidence = record.evidencePointers.slice(0, 3).join(", ") || "none";
  return `${record.decisionId} · ${record.decision}${record.decision === "would_whisper" ? `:${record.riskSeverities[0] || "note"}` : ""} · risks=${risks} · evidence=${evidence}`;
}

function groupLine(group: BoardFlightRecordGroup): string {
  const suffix = group.count > 1 ? ` ×${group.count} (${group.lastAt} → ${group.firstAt})` : "";
  return `${group.firstAt} · ${summaryLine(group.record)}${suffix} · ${group.record.latencyMs}ms`;
}

function topRiskLine(groups: BoardFlightRecordGroup[]): string {
  const active = groups.find((group) => group.record.riskTypes.length > 0);
  if (!active) return "Top active risk: none";
  const record = active.record;
  const risk = record.riskTypes[0] || "unknown";
  const severity = record.riskSeverities[0] || "note";
  const evidence = truncate(record.evidencePointers.slice(0, 5).join(", ") || "none", 220);
  return `Top active risk: ${risk}:${severity} · repeats=${active.count} · evidence=${evidence}`;
}

function evidenceHygieneLine(groups: BoardFlightRecordGroup[]): string {
  const staleGroups = groups.filter((group) => group.record.riskTypes.includes("stale_evidence"));
  if (staleGroups.length === 0) return "Evidence hygiene: no stale-evidence groups in recent telemetry.";
  const compacted = staleGroups.reduce((sum, group) => sum + Math.max(0, group.count - 1), 0);
  return `Evidence hygiene: stale evidence marked in ${staleGroups.length} compacted group(s); ${compacted} repeated stale record(s) collapsed from report detail.`;
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

export function formatBoardFlightStatus(records: BoardFlightRecord[], shadowState?: BoardShadowState, options: BoardFlightReportOptions = {}): string {
  const total = records.length;
  const groups = compactRecords(records);
  const visible = records.filter((record) => record.visibleToUser).length;
  const silent = records.filter((record) => record.decision === "silent").length;
  const ledgerUpdate = records.filter((record) => record.decision === "ledger_update").length;
  const whisper = records.filter((record) => record.decision === "would_whisper").length;
  const avgLatency = total > 0 ? Math.round(records.reduce((sum, record) => sum + record.latencyMs, 0) / total) : 0;
  const totalCost = records.reduce((sum, record) => sum + (record.budget.estimatedCostUsd || 0), 0);
  const compacted = groups.reduce((sum, group) => sum + Math.max(0, group.count - 1), 0);
  const last = records[0];
  return [
    "Board telemetry:",
    options.telemetryPath ? `Telemetry path: ${options.telemetryPath}` : undefined,
    `Decisions: ${total} | Visible: ${visible} | Silent: ${silent} | Ledger updates: ${ledgerUpdate} | Would whisper: ${whisper}`,
    `Compaction: ${compacted} repeated record${compacted === 1 ? "" : "s"} collapsed into ${groups.length} group${groups.length === 1 ? "" : "s"}`,
    `Latency: avg ${avgLatency}ms${last ? ` · last ${last.latencyMs}ms` : ""} · Estimated cost: ${formatCost(totalCost)}`,
    last ? `Last: ${summaryLine(last)}` : "Last: none",
    shadowState?.lastDecision ? `Shadow state: ${shadowState.lastDecision.action}${shadowState.lastSuppressedRiskIds?.length ? ` · suppressed ${shadowState.lastSuppressedRiskIds.length}` : ""}` : "Shadow state: none",
  ].filter(Boolean).join("\n");
}

export function formatBoardFlightReport(records: BoardFlightRecord[], shadowState?: BoardShadowState, options: BoardFlightReportOptions = {}): string {
  const groups = compactRecords(records);
  const recent = groups.slice(0, 5).map((group) => `- ${groupLine(group)}`);
  return [
    formatBoardFlightStatus(records, shadowState, options),
    "",
    "Posture:",
    topRiskLine(groups),
    evidenceHygieneLine(groups),
    "",
    "Recent compacted decisions:",
    ...(recent.length > 0 ? recent : ["- none"]),
  ].join("\n");
}
