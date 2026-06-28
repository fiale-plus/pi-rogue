import { createHash } from "node:crypto";
import type { BoardDecision, BoardLedger, BoardRisk, BoardSeverity, EvidenceEpoch, FailureCluster, SubagentReturnSummary } from "./board.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type HeadOfBoardMode = "off" | "enabled";

export type HeadOfBoardEscalationReason =
  | "specialist_disagreement"
  | "stale_evidence"
  | "architecture_risk"
  | "security_risk"
  | "no_progress_loop"
  | "user_request"
  | "missing_validation"
  | "repeated_failure";

export interface HeadOfBoardConfig {
  mode: HeadOfBoardMode;
  maxEvidence: number;
  maxRisks: number;
  maxFailures: number;
  maxSubagents: number;
  maxTokens: number;
  reasoning: ThinkingLevel;
}

export interface HeadOfBoardPromptInput {
  ledger: BoardLedger;
  decision: BoardDecision;
  question: string;
  reason?: HeadOfBoardEscalationReason;
}

export interface HeadOfBoardRequest {
  role: "head-of-advisory-board";
  sessionId: string;
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
  ledger: {
    session: BoardLedger["session"];
    progress: BoardLedger["progress"];
    changedFiles: string[];
    openRisks: Array<Pick<BoardRisk, "id" | "type" | "severity" | "evidence" | "evidencePointers">>;
    evidenceEpochs: Array<Pick<EvidenceEpoch, "id" | "kind" | "status" | "turn" | "timestamp" | "summary" | "terminal">>;
    failures: Array<Pick<FailureCluster, "key" | "count" | "firstTurn" | "lastTurn" | "tool" | "messages">>;
    specialistFindings: Array<Pick<SubagentReturnSummary, "id" | "role" | "topic" | "verdict" | "summary" | "confidence" | "turn">>;
  };
  escalation: {
    reason: HeadOfBoardEscalationReason;
    severity: BoardSeverity;
    decisionNeeded: string;
    decision: BoardDecision;
  };
  constraints: {
    readOnly: true;
    mutatingTools: [];
    rawTranscript: false;
    episodic: true;
  };
}

export interface HeadOfBoardCompletion {
  text: string;
  model: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
}

export interface HeadOfBoardResult {
  skipped?: "disabled" | "not_material" | "empty_question" | "rate_limited";
  request?: HeadOfBoardRequest;
  response?: HeadOfBoardCompletion;
  accounting: {
    headOfBoardCalls: number;
    navigatorCalls: number;
  };
}

export type HeadOfBoardComplete = (systemPrompt: string, messages: Array<{ role: "user"; content: string }>, options: { maxTokens: number; reasoning: ThinkingLevel }) => Promise<HeadOfBoardCompletion | null>;

const SECRET_RE = /\b(?:(?:sk|ghp|gho|github_pat|xox[abprs]|hf)[-_][A-Za-z0-9_\-]{8,}|AKIA[A-Z0-9]{12,})\b/g;
const KEYED_SECRET_RE = /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;}]{4,}/gi;
const NAMED_SECRET_ASSIGNMENT_RE = /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*[^\s"',;}]{4,}/gi;
const BARE_BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function defaultHeadOfBoardConfig(): HeadOfBoardConfig {
  return {
    mode: "off",
    maxEvidence: 8,
    maxRisks: 6,
    maxFailures: 4,
    maxSubagents: 6,
    maxTokens: 1200,
    reasoning: "medium",
  };
}

export function normalizeHeadOfBoardConfig(raw: unknown): HeadOfBoardConfig {
  const defaults = defaultHeadOfBoardConfig();
  if (!raw || typeof raw !== "object") return defaults;
  const record = raw as Partial<HeadOfBoardConfig>;
  const bounded = (value: unknown, fallback: number, min: number, max: number) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(min, Math.min(max, Math.floor(num))) : fallback;
  };
  return {
    mode: record.mode === "enabled" ? "enabled" : "off",
    maxEvidence: bounded(record.maxEvidence, defaults.maxEvidence, 1, 24),
    maxRisks: bounded(record.maxRisks, defaults.maxRisks, 1, 16),
    maxFailures: bounded(record.maxFailures, defaults.maxFailures, 0, 12),
    maxSubagents: bounded(record.maxSubagents, defaults.maxSubagents, 0, 12),
    maxTokens: bounded(record.maxTokens, defaults.maxTokens, 300, 4000),
    reasoning: record.reasoning === "low" || record.reasoning === "medium" || record.reasoning === "high" ? record.reasoning : defaults.reasoning,
  };
}

function cleanText(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(BARE_BEARER_RE, "Bearer [secret]")
    .replace(SECRET_RE, "[secret]")
    .replace(KEYED_SECRET_RE, (match) => `${match.split(/[:=]/, 1)[0]}=[secret]`)
    .replace(NAMED_SECRET_ASSIGNMENT_RE, (match) => `${match.split(/=/, 1)[0].trim()}=[secret]`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function latestTerminalGreenTurn(evidence: EvidenceEpoch[]): number | undefined {
  let turn: number | undefined;
  for (const item of evidence) {
    if (item.kind === "validation" && item.status === "green" && item.terminal && typeof item.turn === "number") {
      turn = Math.max(turn ?? 0, item.turn);
    }
  }
  return turn;
}

function promotedEvidence(ledger: BoardLedger, maxEvidence: number): HeadOfBoardRequest["ledger"]["evidenceEpochs"] {
  const terminalGreenTurn = latestTerminalGreenTurn(ledger.evidence);
  return ledger.evidence
    .filter((item) => {
      if (terminalGreenTurn === undefined || typeof item.turn !== "number") return true;
      if (item.kind === "validation" && item.status === "green" && item.turn >= terminalGreenTurn) return true;
      return item.turn > terminalGreenTurn;
    })
    .slice(-maxEvidence)
    .map((item) => ({
      id: cleanText(item.id, 120),
      kind: item.kind,
      status: item.status,
      turn: item.turn,
      timestamp: item.timestamp,
      summary: cleanText(item.summary, 240),
      terminal: item.terminal,
    }));
}

function takeTail<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  return items.slice(-limit);
}

function escalationReasonFromRisks(risks: BoardRisk[], fallback: HeadOfBoardEscalationReason): HeadOfBoardEscalationReason {
  const types = new Set(risks.map((risk) => risk.type));
  if (types.has("subagent_contradiction")) return "specialist_disagreement";
  if (types.has("stale_evidence")) return "stale_evidence";
  if (types.has("missing_validation")) return "missing_validation";
  if (types.has("repeated_failure")) return "repeated_failure";
  if (types.has("no_progress")) return "no_progress_loop";
  return fallback;
}

function materialSeverity(decision: BoardDecision, risks: BoardRisk[]): BoardSeverity | undefined {
  if (decision.action === "would_whisper") return decision.severity;
  const blocker = risks.find((risk) => risk.severity === "blocker");
  if (blocker) return "blocker";
  const important = risks.find((risk) => risk.severity === "important");
  return important ? "important" : undefined;
}

function sanitizeBoardDecision(decision: BoardDecision): BoardDecision {
  if (decision.action === "silent") return decision;
  if (decision.action === "ledger_update") return { action: "ledger_update", riskIds: decision.riskIds.map((id) => cleanText(id, 120)) };
  return {
    action: "would_whisper",
    severity: decision.severity,
    reason: cleanText(decision.reason, 240),
    riskIds: decision.riskIds.map((id) => cleanText(id, 120)),
  };
}

function stableSessionId(input: HeadOfBoardPromptInput): string {
  const hash = createHash("sha256").update(JSON.stringify({ session: input.ledger.session, decision: sanitizeBoardDecision(input.decision), question: cleanText(input.question, 600) })).digest("hex").slice(0, 12);
  return `head-of-board:${input.ledger.session.id ?? "session"}:${hash}`;
}

export function shouldEscalateToHeadOfBoard(config: HeadOfBoardConfig, input: HeadOfBoardPromptInput): boolean {
  if (config.mode !== "enabled") return false;
  if (!input.question.trim()) return false;
  if (input.reason === "user_request") return true;
  return Boolean(materialSeverity(input.decision, input.ledger.risks));
}

export function mergeHeadOfBoardRisks(ledger: BoardLedger, promotedRisks: BoardRisk[] | undefined): BoardLedger {
  if (!promotedRisks?.length) return ledger;
  const byId = new Map<string, BoardRisk>();
  for (const risk of ledger.risks) byId.set(risk.id, risk);
  for (const risk of promotedRisks) byId.set(risk.id, risk);
  return { ...ledger, risks: [...byId.values()] };
}

export function buildHeadOfBoardRequest(input: HeadOfBoardPromptInput, config: HeadOfBoardConfig = defaultHeadOfBoardConfig()): HeadOfBoardRequest {
  const risks = input.ledger.risks.slice(0, config.maxRisks);
  const severity = materialSeverity(input.decision, risks) ?? "important";
  const reason = input.reason ?? escalationReasonFromRisks(risks, "architecture_risk");
  const ledger = {
    session: input.ledger.session,
    progress: input.ledger.progress,
    changedFiles: input.ledger.changedFiles.slice(-12).map((file) => cleanText(file, 180)),
    openRisks: risks.map((risk) => ({
      id: cleanText(risk.id, 120),
      type: risk.type,
      severity: risk.severity,
      evidence: cleanText(risk.evidence, 240),
      evidencePointers: risk.evidencePointers.map((pointer) => cleanText(pointer, 120)).slice(0, 8),
    })),
    evidenceEpochs: promotedEvidence(input.ledger, config.maxEvidence),
    failures: takeTail(input.ledger.failures
      .filter((failure) => {
        const terminalGreenTurn = latestTerminalGreenTurn(input.ledger.evidence);
        return terminalGreenTurn === undefined || typeof failure.lastTurn !== "number" || failure.lastTurn > terminalGreenTurn;
      }), config.maxFailures)
      .map((failure) => ({
        key: cleanText(failure.key, 120),
        count: failure.count,
        firstTurn: failure.firstTurn,
        lastTurn: failure.lastTurn,
        tool: failure.tool ? cleanText(failure.tool, 80) : undefined,
        messages: failure.messages.slice(-3).map((message) => cleanText(message, 180)),
      })),
    specialistFindings: takeTail(input.ledger.subagents, config.maxSubagents).map((item) => ({
      id: cleanText(item.id, 120),
      role: cleanText(item.role, 120),
      topic: item.topic ? cleanText(item.topic, 160) : undefined,
      verdict: item.verdict,
      summary: cleanText(item.summary, 260),
      confidence: item.confidence,
      turn: item.turn,
    })),
  };

  const cleanDecision = sanitizeBoardDecision(input.decision);
  const request: HeadOfBoardRequest = {
    role: "head-of-advisory-board",
    sessionId: stableSessionId(input),
    systemPrompt: [
      "You are Pi-Rogue's isolated Head of Advisory Board.",
      "You are read-only: do not request, imply, or perform file edits, shell commands, merges, releases, or other mutations.",
      "Use only the compact board ledger supplied by the navigator; do not assume access to the raw transcript.",
      "Return senior advice/verdict for the decision needed, with concise rationale and concrete next safe action.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        board_ledger: ledger,
        escalation: {
          reason,
          severity,
          decision_needed: cleanText(input.question, 600),
          decision: cleanDecision,
        },
      }, null, 2),
    }],
    ledger,
    escalation: {
      reason,
      severity,
      decisionNeeded: cleanText(input.question, 600),
      decision: cleanDecision,
    },
    constraints: {
      readOnly: true,
      mutatingTools: [],
      rawTranscript: false,
      episodic: true,
    },
  };
  return request;
}

export async function callHeadOfBoardAdapter(config: HeadOfBoardConfig, input: HeadOfBoardPromptInput, complete: HeadOfBoardComplete): Promise<HeadOfBoardResult> {
  if (config.mode !== "enabled") return { skipped: "disabled", accounting: { headOfBoardCalls: 0, navigatorCalls: 0 } };
  if (!input.question.trim()) return { skipped: "empty_question", accounting: { headOfBoardCalls: 0, navigatorCalls: 0 } };
  if (!shouldEscalateToHeadOfBoard(config, input)) return { skipped: "not_material", accounting: { headOfBoardCalls: 0, navigatorCalls: 0 } };
  const request = buildHeadOfBoardRequest(input, config);
  const response = await complete(request.systemPrompt, request.messages, { maxTokens: config.maxTokens, reasoning: config.reasoning }) ?? undefined;
  if (response?.rateLimited) return { skipped: "rate_limited", request, response, accounting: { headOfBoardCalls: 0, navigatorCalls: 0 } };
  return { request, response, accounting: { headOfBoardCalls: response ? 1 : 0, navigatorCalls: 0 } };
}
