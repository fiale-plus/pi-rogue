import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { featureFile, truncate } from "@fiale-plus/pi-core";
import type { RiskScan } from "@fiale-plus/pi-core";

const LEDGER_PATH = featureFile("guardrails", "restore-ledger.json");
const SNAPSHOT_DIR = join(dirname(LEDGER_PATH), "restore-snapshots");
const LEDGER_VERSION = 1;
const MAX_LEDGER_BYTES = 128 * 1024;
const MAX_LEDGER_ENTRIES = 120;
const MAX_ACTIVE_ENTRIES = 32;
const RESTORE_WINDOW_MS = 30 * 60 * 1000;
const MAX_PATCH_BYTES = 60_000;

export type RestoreStatus =
  | "destructive-detected"
  | "snapshot-saved"
  | "snapshot-failed"
  | "executed"
  | "aborted"
  | "blocked"
  | "skipped"
  | "expired";

interface GitSnapshot {
  type: "git-patch";
  root: string;
  patchPath: string;
  statusPath: string;
  statusText: string;
  truncated: boolean;
  truncatedAt?: number;
}

interface RestoreLedgerEntry {
  id: string;
  createdAt: number;
  session: string;
  command: string;
  commandHash: string;
  status: RestoreStatus;
  severity: "safe" | "warn" | "danger";
  reason: string;
  reversible: boolean;
  restoreWindowUntil: number;
  snapshot?: GitSnapshot;
  targetPaths: string[];
  finalReason?: string;
}

interface RestoreLedger {
  version: number;
  entries: RestoreLedgerEntry[];
}

function ensurePaths(): void {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function readLedger(): RestoreLedger {
  ensurePaths();
  try {
    const raw = readFileSync(LEDGER_PATH, "utf8");
    if (!raw.trim()) return { version: LEDGER_VERSION, entries: [] };
    const parsed = JSON.parse(raw) as RestoreLedger;
    if (!Array.isArray(parsed.entries)) return { version: LEDGER_VERSION, entries: [] };
    return {
      version: typeof parsed.version === "number" ? parsed.version : LEDGER_VERSION,
      entries: parsed.entries.filter((entry): entry is RestoreLedgerEntry => Boolean(entry && typeof entry.id === "string")),
    };
  } catch {
    return { version: LEDGER_VERSION, entries: [] };
  }
}

function writeLedger(ledger: RestoreLedger): void {
  ensurePaths();
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function ledgerByteSize(ledger: RestoreLedger): number {
  return Buffer.byteLength(JSON.stringify(ledger), "utf8");
}

function snapshotPath(id: string, kind: string): string {
  return join(SNAPSHOT_DIR, `${id}.${kind}`);
}

function hashCommand(command: string): string {
  const normalized = String(command || "").trim().toLowerCase();
  return normalized.length < 12
    ? normalized || randomUUID().slice(0, 12)
    : normalized.slice(0, 12);
}

function isGitRepo(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function truncateText(text: string, limit: number): string {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function captureGitSnapshot(entryId: string, _command: string): GitSnapshot | null {
  const root = isGitRepo();
  if (!root) return null;

  const patch = execFileSync("git", ["-C", root, "diff", "--binary"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });

  const status = execFileSync("git", ["-C", root, "status", "--short", "--untracked-files=all"], {
    encoding: "utf8",
  });

  const truncated = patch.length > MAX_PATCH_BYTES;
  const payload = truncated
    ? `${patch.slice(0, MAX_PATCH_BYTES)}\n\n...patched snapshot truncated for capped storage...\n`
    : patch;

  const patchPath = snapshotPath(entryId, "patch");
  const statusPath = snapshotPath(entryId, "status");
  writeFileSync(patchPath, payload, "utf8");
  writeFileSync(statusPath, status || "", "utf8");

  return {
    type: "git-patch",
    root,
    patchPath,
    statusPath,
    statusText: truncateText(status, 280),
    truncated,
    truncatedAt: truncated ? Date.now() : undefined,
  };
}

function cleanupSnapshot(snapshot?: GitSnapshot): void {
  if (!snapshot) return;
  for (const file of [snapshot.patchPath, snapshot.statusPath]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

function isOpenForRestore(entry: RestoreLedgerEntry, now = Date.now()): boolean {
  return (entry.status === "snapshot-saved" || entry.status === "executed") && entry.restoreWindowUntil > now;
}

function pruneLedger(): RestoreLedger {
  const now = Date.now();
  const ledger = readLedger();

  // Mark expired entries.
  let changed = false;
  for (const entry of ledger.entries) {
    if (isOpenForRestore(entry, now)) continue;
    if (entry.restoreWindowUntil && entry.restoreWindowUntil <= now && (entry.status === "snapshot-saved" || entry.status === "executed")) {
      entry.status = "expired";
      changed = true;
      if (entry.snapshot) {
        cleanupSnapshot(entry.snapshot);
        entry.snapshot = undefined;
      }
    }
  }

  const active = ledger.entries.filter((entry) => isOpenForRestore(entry, now));

  // Keep all active windows first, then prune oldest closed entries by bytes / count.
  let retain = [...ledger.entries].sort((a, b) => b.createdAt - a.createdAt);
  const keepSet = new Set<string>(active.map((entry) => entry.id));

  while (ledgerByteSize({ ...ledger, entries: retain }) > MAX_LEDGER_BYTES || retain.length > MAX_LEDGER_ENTRIES) {
    const candidateIndex = [...retain]
      .map((entry, i) => ({ entry, i }))
      .reverse()
      .find(({ entry }) => !keepSet.has(entry.id))?.i;

    if (candidateIndex === undefined) break;
    const [removed] = retain.splice(candidateIndex, 1);
    if (removed?.snapshot) {
      cleanupSnapshot(removed.snapshot);
    }
    changed = true;
  }

  if (retain.length > MAX_ACTIVE_ENTRIES && active.length > MAX_ACTIVE_ENTRIES) {
    // If active windows explode, keep most recent active only.
    const sortedActive = active
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ACTIVE_ENTRIES)
      .map((entry) => entry.id);
    const next = retain.filter((entry) => entry.status !== "snapshot-saved" && entry.status !== "executed" || sortedActive.includes(entry.id));
    if (next.length < retain.length) {
      const dropped = retain.filter((entry) => !next.includes(entry));
      for (const removed of dropped) if (removed.snapshot) cleanupSnapshot(removed.snapshot);
      retain = next;
      changed = true;
    }
  }

  if (!changed) return ledger;

  const next: RestoreLedger = {
    ...ledger,
    version: LEDGER_VERSION,
    entries: retain.sort((a, b) => b.createdAt - a.createdAt),
  };
  writeLedger(next);
  return next;
}

export function classifyReversible(command: string, scan: RiskScan): boolean {
  if (scan.safe || scan.severity !== "danger") return false;
  const text = String(command || "").toLowerCase();
  if (/\bgit\s+(checkout|restore|switch|revert)\b/.test(text)) return true;
  if (/\bcp\b/.test(text) || /\bmv\b/.test(text)) return true;
  if (/\brm\b/.test(text) && /\b-r\b/.test(text) === false) {
    return true;
  }
  return false;
}

export async function startRestoreTransaction(
  command: string,
  scan: RiskScan,
  ctx: any,
): Promise<RestoreLedgerEntry | null> {
  const reversible = classifyReversible(command, scan);
  if (scan.safe || !reversible) {
    const entry: RestoreLedgerEntry = {
      id: randomUUID(),
      createdAt: Date.now(),
      session: String(ctx?.sessionManager?.getSessionFile?.() || "session"),
      command: String(command || ""),
      commandHash: hashCommand(String(command || "")),
      status: "skipped",
      severity: scan.safe ? "safe" : scan.severity,
      reason: scan.reason,
      reversible,
      restoreWindowUntil: 0,
      targetPaths: [],
    };

    const ledger = pruneLedger();
    ledger.entries = [entry, ...ledger.entries].slice(0, MAX_LEDGER_ENTRIES * 2);
    writeLedger(ledger);
    return entry;
  }

  const now = Date.now();
  const entry: RestoreLedgerEntry = {
    id: randomUUID(),
    createdAt: now,
    session: String(ctx?.sessionManager?.getSessionFile?.() || "session"),
    command: String(command || ""),
    commandHash: hashCommand(String(command || "")),
    status: "destructive-detected",
    severity: scan.severity,
    reason: scan.reason,
    reversible,
    restoreWindowUntil: 0,
    targetPaths: [],
  };

  let snapshot: GitSnapshot | null = null;
  try {
    snapshot = captureGitSnapshot(entry.id, command);
    entry.snapshot = snapshot ?? undefined;
    entry.status = snapshot ? "snapshot-saved" : "snapshot-failed";
    entry.restoreWindowUntil = snapshot ? now + RESTORE_WINDOW_MS : 0;
  } catch {
    entry.status = "snapshot-failed";
    entry.restoreWindowUntil = 0;
    snapshot = null;
  }

  const ledger = pruneLedger();
  ledger.entries = [entry, ...ledger.entries];
  writeLedger(ledger);
  return entry;
}

export function completeRestoreTransaction(
  txId: string,
  outcome: "executed" | "blocked" | "aborted",
): void {
  const ledger = readLedger();
  const now = Date.now();
  let changed = false;

  const idx = ledger.entries.findIndex((entry) => entry.id === txId);
  if (idx < 0) return;

  const entry = ledger.entries[idx]!;
  entry.finalReason = entry.finalReason ?? outcome;

  if (outcome === "executed") {
    if (entry.status === "snapshot-saved" && entry.snapshot) {
      entry.status = "executed";
      entry.restoreWindowUntil = now + RESTORE_WINDOW_MS;
      changed = true;
    }
    if (changed) writeLedger(ledger);
    return;
  }

  if (outcome === "blocked" || outcome === "aborted") {
    entry.status = outcome;
    entry.restoreWindowUntil = 0;
    if (entry.snapshot) {
      cleanupSnapshot(entry.snapshot);
      entry.snapshot = undefined;
    }
    writeLedger(ledger);
  }
}

export function restoreLedgerSummary(): string {
  const now = Date.now();
  const ledger = pruneLedger();
  const active = ledger.entries.filter((entry) => isOpenForRestore(entry, now));
  const lines = active
    .slice(0, 3)
    .map((entry) => {
      const ageMs = Math.max(0, now - entry.createdAt);
      const ageMin = Math.floor(ageMs / 60_000);
      return `- ${entry.id.slice(0, 8)}: ${entry.status} · ${truncate(entry.command, 60)} · ${ageMin}m`;
    });

  const summary = `Restore ledger: ${active.length} active window(s), ${ledger.entries.length} retained entry(ies).`;
  if (lines.length === 0) {
    return `${summary}`;
  }

  return `${summary}\n${lines.join("\n")}`;
}

export function renderRestoreNote(entry: RestoreLedgerEntry | null): string {
  if (!entry) return "";
  if (entry.status === "snapshot-saved") {
    return `Restore window started for tx=${entry.id.slice(0, 8)} (expires in 30m).`;
  }

  if (entry.status === "snapshot-failed") {
    return `Snapshot failed for tx=${entry.id.slice(0, 8)}; proceeding with guardrails gating.`;
  }

  if (entry.status === "destructive-detected") {
    return `Destructive op detected: tx=${entry.id.slice(0, 8)}.`;
  }

  return "";
}

export function clearExpiredRestoreTransactions(): void {
  pruneLedger();
}

export function ledgerBytes(): number {
  return ledgerByteSize(readLedger());
}

