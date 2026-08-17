import { sessionFile, sessionKey } from "@fiale-plus/pi-core";
import { atomicWriteText, readText } from "./internal.js";

export const CLOSEOUT_VERSION = 1;
const MAX_SUMMARY = 500;
const MAX_EVIDENCE = 24;
const MAX_FILES = 24;
const MAX_VALIDATIONS = 24;
const MAX_FAILURES = 12;

export type CloseoutStatus = "open" | "success" | "partial" | "failed" | "abandoned";
export type CloseoutEvidenceKind = "handle" | "path" | "note";

export type CloseoutEvidence = {
  kind: CloseoutEvidenceKind;
  reference: string;
  addedAt: string;
};

export type CloseoutValidation = {
  command: string;
  result: "pass" | "fail" | "error" | "unknown";
  exitCode?: number;
  timestamp: string;
};

export type CloseoutFacts = {
  turns: number;
  changedFiles: string[];
  validations: CloseoutValidation[];
  failures: string[];
  advisorCalls: number;
  specialistCalls: number;
  headCalls: number;
};

export type CloseoutRecord = {
  version: typeof CLOSEOUT_VERSION;
  session: {
    key: string;
    cwd?: string;
    sessionFile?: string;
  };
  status: CloseoutStatus;
  summary: string;
  startedAt: string;
  updatedAt: string;
  evidence: CloseoutEvidence[];
  unresolvedRisks: string[];
  facts: CloseoutFacts;
};

type UnknownRecord = Record<string, unknown>;

function text(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/([\"']?(?:api[_-]?key|token|secret|password|credential)[\w.-]*[\"']?\s*[:=]\s*[\"']?)([^\s'\",;}]+)/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function boundedList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, itemMax)).filter(Boolean).slice(-max);
}

function closeoutPath(ctx: unknown): string {
  return sessionFile("closeout", ctx, "record.json");
}

function closeoutExportPath(ctx: unknown): string {
  return sessionFile("closeout", ctx, "closeout.md");
}

function status(value: unknown): CloseoutStatus {
  return value === "success" || value === "partial" || value === "failed" || value === "abandoned" ? value : "open";
}

function normalizeEvidence(value: unknown): CloseoutEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CloseoutEvidence[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as UnknownRecord;
    const reference = text(entry.reference, 400);
    if (!reference) return [];
    const kind = entry.kind === "handle" || entry.kind === "path" || entry.kind === "note" ? entry.kind : "note";
    return [{ kind, reference, addedAt: text(entry.addedAt, 80) || new Date().toISOString() }];
  }).slice(-MAX_EVIDENCE);
}

function normalizeValidations(value: unknown): CloseoutValidation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CloseoutValidation[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as UnknownRecord;
    const command = text(entry.command, 240);
    if (!command) return [];
    const result = entry.result === "pass" || entry.result === "fail" || entry.result === "error" ? entry.result : "unknown";
    const exitCode = Number(entry.exitCode);
    return [{
      command,
      result,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      timestamp: text(entry.timestamp, 80) || new Date().toISOString(),
    }];
  }).slice(-MAX_VALIDATIONS);
}

function normalizeFacts(value: unknown): CloseoutFacts {
  const source = value && typeof value === "object" ? value as UnknownRecord : {};
  const count = (candidate: unknown): number => Number.isFinite(Number(candidate)) ? Math.max(0, Math.floor(Number(candidate))) : 0;
  return {
    turns: count(source.turns),
    changedFiles: boundedList(source.changedFiles, MAX_FILES, 240),
    validations: normalizeValidations(source.validations),
    failures: boundedList(source.failures, MAX_FAILURES, 300),
    advisorCalls: count(source.advisorCalls),
    specialistCalls: count(source.specialistCalls),
    headCalls: count(source.headCalls),
  };
}

export function normalizeCloseout(raw: unknown, ctx?: any): CloseoutRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as UnknownRecord;
  const sessionSource = source.session && typeof source.session === "object" ? source.session as UnknownRecord : {};
  const key = text(sessionSource.key, 180);
  if (!key || (ctx && key !== sessionKey(ctx))) return undefined;
  const now = new Date().toISOString();
  return {
    version: CLOSEOUT_VERSION,
    session: {
      key,
      cwd: text(sessionSource.cwd, 500) || undefined,
      sessionFile: text(sessionSource.sessionFile, 500) || undefined,
    },
    status: status(source.status),
    summary: text(source.summary, MAX_SUMMARY),
    startedAt: text(source.startedAt, 80) || now,
    updatedAt: text(source.updatedAt, 80) || now,
    evidence: normalizeEvidence(source.evidence),
    unresolvedRisks: boundedList(source.unresolvedRisks, MAX_FAILURES, 300),
    facts: normalizeFacts(source.facts),
  };
}

export function loadCloseout(ctx: any): CloseoutRecord | undefined {
  try {
    return normalizeCloseout(JSON.parse(readText(closeoutPath(ctx))), ctx);
  } catch {
    return undefined;
  }
}

function saveCloseout(ctx: any, record: CloseoutRecord): CloseoutRecord {
  const normalized = normalizeCloseout(record, ctx) ?? record;
  atomicWriteText(closeoutPath(ctx), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function sessionMetadata(ctx: any): CloseoutRecord["session"] {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  return {
    key: sessionKey(ctx),
    cwd: text(ctx?.cwd, 500) || undefined,
    sessionFile: typeof sessionFile === "string" && sessionFile ? text(sessionFile, 500) : undefined,
  };
}

export function startCloseout(ctx: any, summary = ""): CloseoutRecord {
  const now = new Date().toISOString();
  return saveCloseout(ctx, {
    version: CLOSEOUT_VERSION,
    session: sessionMetadata(ctx),
    status: "open",
    summary: text(summary, MAX_SUMMARY),
    startedAt: now,
    updatedAt: now,
    evidence: [],
    unresolvedRisks: [],
    facts: emptyFacts(),
  });
}

export function recordCloseoutStatus(ctx: any, nextStatus: Exclude<CloseoutStatus, "open">): CloseoutRecord | undefined {
  const current = loadCloseout(ctx);
  if (!current) return undefined;
  return saveCloseout(ctx, { ...current, status: nextStatus, updatedAt: new Date().toISOString() });
}

export function addCloseoutEvidence(ctx: any, reference: string): CloseoutRecord | undefined {
  const current = loadCloseout(ctx);
  const cleanReference = text(reference, 400);
  if (!current || !cleanReference) return undefined;
  const kind: CloseoutEvidenceKind = cleanReference.startsWith("ctx://") ? "handle" : cleanReference.startsWith("/") || cleanReference.includes("/") ? "path" : "note";
  return saveCloseout(ctx, {
    ...current,
    updatedAt: new Date().toISOString(),
    evidence: [...current.evidence, { kind, reference: cleanReference, addedAt: new Date().toISOString() }].slice(-MAX_EVIDENCE),
  });
}

export function emptyFacts(): CloseoutFacts {
  return { turns: 0, changedFiles: [], validations: [], failures: [], advisorCalls: 0, specialistCalls: 0, headCalls: 0 };
}

export function syncCloseoutFacts(ctx: any, state: any): CloseoutRecord | undefined {
  const current = loadCloseout(ctx);
  if (!current) return undefined;
  const evidence = Array.isArray(state?.evidenceLedger)
    ? state.evidenceLedger.filter((entry: any) => entry?.kind === "validation")
    : [];
  const validations: CloseoutValidation[] = evidence.flatMap((entry: any): CloseoutValidation[] => {
    const command = text(entry?.command ?? entry?.source, 240);
    if (!command) return [];
    const result = entry?.result === "pass" ? "pass" : entry?.result === "fail" ? "fail" : entry?.result === "error" ? "error" : "unknown";
    const exitCode = Number(entry?.exitCode);
    return [{ command, result, exitCode: Number.isFinite(exitCode) ? exitCode : undefined, timestamp: text(entry?.timestamp, 80) || new Date().toISOString() }];
  });
  const next: CloseoutRecord = {
    ...current,
    updatedAt: new Date().toISOString(),
    facts: normalizeFacts({
      turns: state?.turns,
      changedFiles: [
        ...(Array.isArray(state?.files) ? state.files : []),
        ...(Array.isArray(state?.boardEvents)
          ? state.boardEvents.filter((entry: any) => entry?.type === "file_changed").map((entry: any) => entry.path)
          : []),
      ],
      validations,
      failures: state?.errors,
      advisorCalls: state?.advisorCalls,
      specialistCalls: state?.specialistDispatch?.calls,
      headCalls: state?.headOfBoard?.calls,
    }),
    unresolvedRisks: boundedList(state?.errors, MAX_FAILURES, 300),
  };
  return saveCloseout(ctx, next);
}

function markdown(record: CloseoutRecord): string {
  const lines = [
    "# Pi-Rogue session closeout",
    "",
    `- Status: **${record.status}**`,
    `- Session: \`${record.session.key}\``,
    record.session.cwd ? `- Working directory: \`${record.session.cwd}\`` : "",
    `- Started: ${record.startedAt}`,
    `- Updated: ${record.updatedAt}`,
    "",
    "## Summary",
    "",
    record.summary || "(no summary recorded)",
    "",
    "## Facts",
    "",
    `- Turns: ${record.facts.turns}`,
    `- Changed files observed: ${record.facts.changedFiles.length}`,
    `- Advisor calls: ${record.facts.advisorCalls}; specialists: ${record.facts.specialistCalls}; head: ${record.facts.headCalls}`,
    "",
    "### Changed files",
    "",
    ...(record.facts.changedFiles.length ? record.facts.changedFiles.map((file) => `- \`${file}\``) : ["- None recorded"]),
    "",
    "### Validation",
    "",
    ...(record.facts.validations.length ? record.facts.validations.map((item) => `- ${item.result}: \`${item.command}\`${item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`}`) : ["- None recorded"]),
    "",
    "## Evidence references",
    "",
    ...(record.evidence.length ? record.evidence.map((item) => `- ${item.kind}: \`${item.reference}\``) : ["- None recorded"]),
    "",
    "## Unresolved risks",
    "",
    ...(record.unresolvedRisks.length ? record.unresolvedRisks.map((risk) => `- ${risk}`) : ["- None recorded"]),
    "",
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

export function closeoutText(record: CloseoutRecord | undefined): string {
  return record ? markdown(record) : "No closeout is active. Start one with /pi-rogue closeout start [summary].";
}

export function exportCloseout(ctx: any): { record?: CloseoutRecord; path?: string } {
  const record = loadCloseout(ctx);
  if (!record) return {};
  const path = closeoutExportPath(ctx);
  atomicWriteText(path, markdown(record));
  return { record, path };
}

export function closeoutFilePath(ctx: any): string {
  return closeoutPath(ctx);
}
