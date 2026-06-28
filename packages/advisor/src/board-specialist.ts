import type { BoardLedger, BoardRisk, EvidenceEpoch, FailureCluster } from "./board.js";
import type { BoardRoleBody, BoardRoleCostTier, BoardRoleSummary, BoardRoleTool } from "./board-roles.js";

export type SpecialistDispatchMode = "off" | "suggest" | "auto";
export type SpecialistDenyReason = "disabled" | "not_specialist" | "not_callable" | "tool_escalation" | "cooldown" | "budget" | "cost_tier" | "empty_task";

export interface SpecialistDispatchConfig {
  mode: SpecialistDispatchMode;
  cooldownTurns: number;
  maxCallsPerSession: number;
  maxCostTier: BoardRoleCostTier;
  maxTokens: number;
}

export interface SpecialistCallState {
  calls: number;
  byRole: Record<string, { calls: number; lastTurn?: number }>;
}

export interface SpecialistPolicyInput {
  role: BoardRoleSummary;
  caller: "codriver" | "user" | "navigator" | "head-of-board";
  config: SpecialistDispatchConfig;
  state: SpecialistCallState;
  currentTurn: number;
  task: string;
}

export interface SpecialistPolicyDecision {
  allowed: boolean;
  reason?: SpecialistDenyReason;
}

export interface BoardSpecialistFinding {
  path?: string;
  evidence: string;
  risk: string;
}

export interface BoardSpecialistResponse {
  verdict: "note" | "important" | "blocker";
  confidence: number;
  findings: BoardSpecialistFinding[];
  recommendation: string;
}

export interface SpecialistDispatchRequest {
  roleId: string;
  roleTitle: string;
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
  compactLedger: {
    progress: BoardLedger["progress"];
    risks: Array<Pick<BoardRisk, "id" | "type" | "severity" | "evidence" | "evidencePointers">>;
    evidence: Array<Pick<EvidenceEpoch, "id" | "kind" | "status" | "turn" | "summary" | "terminal">>;
    failures: Array<Pick<FailureCluster, "key" | "count" | "lastTurn" | "tool" | "messages">>;
  };
}

export interface SpecialistDispatchResult {
  request: SpecialistDispatchRequest;
  response: BoardSpecialistResponse;
  note: string;
  state: SpecialistCallState;
}

export interface SpecialistDispatchFailure {
  request: SpecialistDispatchRequest;
  error: string;
  state: SpecialistCallState;
}

export type SpecialistComplete = (systemPrompt: string, messages: Array<{ role: "user"; content: string }>, options: { maxTokens: number }) => Promise<string>;

const READ_ONLY_TOOLS = new Set<BoardRoleTool>(["read", "search", "context_lookup"]);
const COST_ORDER: BoardRoleCostTier[] = ["free", "cheap", "standard", "expensive"];
const SECRET_RE = /\b(?:(?:sk|ghp|gho|github_pat|xox[abprs]|hf)[-_][A-Za-z0-9_\-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g;
const KEYED_SECRET_RE = /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;}]{4,}/gi;
const NAMED_SECRET_ASSIGNMENT_RE = /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*[^\s"',;}]{4,}/gi;
const BARE_BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function defaultSpecialistDispatchConfig(): SpecialistDispatchConfig {
  return { mode: "suggest", cooldownTurns: 6, maxCallsPerSession: 3, maxCostTier: "cheap", maxTokens: 900 };
}

export function normalizeSpecialistDispatchConfig(raw: unknown): SpecialistDispatchConfig {
  const defaults = defaultSpecialistDispatchConfig();
  if (!raw || typeof raw !== "object") return defaults;
  const record = raw as Partial<SpecialistDispatchConfig>;
  const bounded = (value: unknown, fallback: number, min: number, max: number) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(min, Math.min(max, Math.floor(num))) : fallback;
  };
  return {
    mode: record.mode === "off" || record.mode === "auto" ? record.mode : "suggest",
    cooldownTurns: bounded(record.cooldownTurns, defaults.cooldownTurns, 0, 100),
    maxCallsPerSession: bounded(record.maxCallsPerSession, defaults.maxCallsPerSession, 0, 20),
    maxCostTier: record.maxCostTier === "free" || record.maxCostTier === "cheap" || record.maxCostTier === "standard" || record.maxCostTier === "expensive" ? record.maxCostTier : defaults.maxCostTier,
    maxTokens: bounded(record.maxTokens, defaults.maxTokens, 100, 4000),
  };
}

export function defaultSpecialistCallState(): SpecialistCallState {
  return { calls: 0, byRole: {} };
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

function costAllowed(roleTier: BoardRoleCostTier, maxTier: BoardRoleCostTier): boolean {
  return COST_ORDER.indexOf(roleTier) <= COST_ORDER.indexOf(maxTier);
}

export function evaluateSpecialistPolicy(input: SpecialistPolicyInput): SpecialistPolicyDecision {
  const roleState = input.state.byRole[input.role.id];
  if (!input.task.trim()) return { allowed: false, reason: "empty_task" };
  if (input.config.mode === "off") return { allowed: false, reason: "disabled" };
  if (!input.role.enabledByDefault) return { allowed: false, reason: "disabled" };
  if (input.role.kind !== "specialist") return { allowed: false, reason: "not_specialist" };
  if (!input.role.callableBy.includes(input.caller)) return { allowed: false, reason: "not_callable" };
  if (input.role.allowedTools.some((tool) => !READ_ONLY_TOOLS.has(tool))) return { allowed: false, reason: "tool_escalation" };
  if (!costAllowed(input.role.costTier, input.config.maxCostTier)) return { allowed: false, reason: "cost_tier" };
  if (input.state.calls >= input.config.maxCallsPerSession) return { allowed: false, reason: "budget" };
  if (roleState?.lastTurn !== undefined && input.currentTurn - roleState.lastTurn < input.config.cooldownTurns) return { allowed: false, reason: "cooldown" };
  return { allowed: true };
}

export function suggestSpecialistRoles(roles: BoardRoleSummary[], ledger: BoardLedger, limit = 3): BoardRoleSummary[] {
  const text = [
    ...ledger.risks.map((risk) => `${risk.type} ${risk.evidence}`),
    ...ledger.evidence.map((item) => `${item.kind} ${item.status} ${item.summary}`),
    ...ledger.failures.flatMap((failure) => [failure.key, failure.tool ?? "", ...failure.messages]),
  ].join(" ").toLowerCase();
  return roles
    .filter((role) => role.kind === "specialist" && role.enabledByDefault && role.callableBy.includes("codriver"))
    .map((role) => ({ role, score: role.triggerHints.reduce((sum, hint) => sum + (text.includes(hint) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.role.id.localeCompare(b.role.id))
    .slice(0, limit)
    .map((item) => item.role);
}

function compactLedger(ledger: BoardLedger): SpecialistDispatchRequest["compactLedger"] {
  return {
    progress: ledger.progress,
    risks: ledger.risks.slice(0, 6).map((risk) => ({
      id: cleanText(risk.id, 120),
      type: risk.type,
      severity: risk.severity,
      evidence: cleanText(risk.evidence, 240),
      evidencePointers: risk.evidencePointers.map((pointer) => cleanText(pointer, 120)).slice(0, 6),
    })),
    evidence: ledger.evidence.slice(-6).map((item) => ({
      id: cleanText(item.id, 120),
      kind: item.kind,
      status: item.status,
      turn: item.turn,
      summary: cleanText(item.summary, 240),
      terminal: item.terminal,
    })),
    failures: ledger.failures.slice(-4).map((failure) => ({
      key: cleanText(failure.key, 120),
      count: failure.count,
      lastTurn: failure.lastTurn,
      tool: failure.tool ? cleanText(failure.tool, 80) : undefined,
      messages: failure.messages.slice(-2).map((message) => cleanText(message, 180)),
    })),
  };
}

export function buildSpecialistDispatchRequest(role: BoardRoleBody, ledger: BoardLedger, task: string): SpecialistDispatchRequest {
  const compact = compactLedger(ledger);
  return {
    roleId: role.id,
    roleTitle: role.title,
    systemPrompt: [
      `You are the Advisor Board read-only specialist '${role.title}'.`,
      role.body,
      "You may inspect only the compact ledger and task below. Do not request or perform edits, writes, shell commands, commits, pushes, releases, settings changes, or workflow skills.",
      "Return strict JSON only: {\"verdict\":\"note|important|blocker\",\"confidence\":0..1,\"findings\":[{\"path\":string,\"evidence\":string,\"risk\":string}],\"recommendation\":string}.",
    ].join("\n\n"),
    messages: [{ role: "user", content: JSON.stringify({ task: cleanText(task, 600), board_ledger: compact }, null, 2) }],
    compactLedger: compact,
  };
}

export function parseSpecialistResponse(text: string): BoardSpecialistResponse {
  const parsed = JSON.parse(text) as Partial<BoardSpecialistResponse>;
  if (parsed.verdict !== "note" && parsed.verdict !== "important" && parsed.verdict !== "blocker") throw new Error("invalid specialist verdict");
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("invalid specialist confidence");
  if (!Array.isArray(parsed.findings)) throw new Error("invalid specialist findings");
  const findings = parsed.findings.slice(0, 8).map((finding) => {
    if (!finding || typeof finding !== "object") throw new Error("invalid specialist finding");
    const record = finding as Partial<BoardSpecialistFinding>;
    if (typeof record.evidence !== "string" || typeof record.risk !== "string") throw new Error("invalid specialist finding fields");
    return { path: record.path ? cleanText(record.path, 180) : undefined, evidence: cleanText(record.evidence, 240), risk: cleanText(record.risk, 240) };
  });
  if (typeof parsed.recommendation !== "string" || !parsed.recommendation.trim()) throw new Error("invalid specialist recommendation");
  return { verdict: parsed.verdict, confidence, findings, recommendation: cleanText(parsed.recommendation, 400) };
}

export async function callReadOnlySpecialist(input: { role: BoardRoleBody; ledger: BoardLedger; task: string; config: SpecialistDispatchConfig; state: SpecialistCallState; currentTurn: number; complete: SpecialistComplete }): Promise<SpecialistDispatchResult | SpecialistDispatchFailure | { denied: SpecialistDenyReason }> {
  const policy = evaluateSpecialistPolicy({ role: input.role, caller: "codriver", config: input.config, state: input.state, currentTurn: input.currentTurn, task: input.task });
  if (!policy.allowed) return { denied: policy.reason ?? "disabled" };
  const request = buildSpecialistDispatchRequest(input.role, input.ledger, input.task);
  const nextState: SpecialistCallState = {
    calls: input.state.calls + 1,
    byRole: {
      ...input.state.byRole,
      [input.role.id]: { calls: (input.state.byRole[input.role.id]?.calls ?? 0) + 1, lastTurn: input.currentTurn },
    },
  };
  try {
    const raw = await input.complete(request.systemPrompt, request.messages, { maxTokens: Math.min(input.config.maxTokens, input.role.maxTokens) });
    const response = parseSpecialistResponse(raw);
    const note = `${input.role.id}: ${response.verdict} (${Math.round(response.confidence * 100)}%) — ${response.recommendation}`;
    return { request, response, note, state: nextState };
  } catch (error) {
    return { request, error: error instanceof Error ? error.message : String(error), state: nextState };
  }
}
