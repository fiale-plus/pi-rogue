export type BoardSeverity = "note" | "important" | "blocker";

export type BoardEvent =
  | {
      type: "session";
      id: string;
      repo?: string;
      branch?: string;
      worktree?: string;
      timestamp?: string;
    }
  | {
      type: "turn";
      turn: number;
      timestamp?: string;
      progress?: boolean;
      costUsd?: number;
    }
  | {
      type: "file_changed";
      path: string;
      turn?: number;
      timestamp?: string;
    }
  | {
      type: "validation";
      command: string;
      exitCode: number;
      status: "green" | "red" | "unknown";
      turn?: number;
      timestamp?: string;
      terminal?: boolean;
    }
  | {
      type: "tool_failure";
      tool: string;
      key: string;
      message?: string;
      turn?: number;
      timestamp?: string;
    }
  | {
      type: "subagent_return";
      id: string;
      role: string;
      topic?: string;
      verdict: "green" | "red" | "unknown";
      summary: string;
      confidence?: number;
      turn?: number;
      timestamp?: string;
    };

export interface EvidenceEpoch {
  id: string;
  kind: "validation" | "tool_failure" | "subagent";
  status: "green" | "red" | "unknown";
  turn?: number;
  timestamp?: string;
  summary: string;
  terminal?: boolean;
}

export interface FailureCluster {
  key: string;
  count: number;
  firstTurn?: number;
  lastTurn?: number;
  tool?: string;
  messages: string[];
}

export interface SubagentReturnSummary {
  id: string;
  role: string;
  topic?: string;
  verdict: "green" | "red" | "unknown";
  summary: string;
  confidence?: number;
  turn?: number;
}

export interface BoardRisk {
  id: string;
  type: "stale_evidence" | "repeated_failure" | "missing_validation" | "no_progress" | "subagent_contradiction";
  severity: BoardSeverity;
  evidence: string;
  evidencePointers: string[];
}

export interface BoardLedger {
  session: {
    id?: string;
    repo?: string;
    branch?: string;
    worktree?: string;
  };
  changedFiles: string[];
  changedFileTurns: Record<string, number>;
  evidence: EvidenceEpoch[];
  failures: FailureCluster[];
  subagents: SubagentReturnSummary[];
  progress: {
    turns: number;
    lastProgressTurn?: number;
    lastChangeTurn?: number;
    lastValidationTurn?: number;
    costUsd: number;
  };
  risks: BoardRisk[];
}

export type BoardDecision =
  | { action: "silent" }
  | { action: "ledger_update"; riskIds: string[] }
  | { action: "would_whisper"; severity: BoardSeverity; reason: string; riskIds: string[] };

export interface BoardFixture {
  id: string;
  expectedEdgeMoment: string;
  expectedRiskTypes?: BoardRisk["type"][];
  events: BoardEvent[];
}

export interface BoardEvalReportRow {
  fixtureId: string;
  expectedEdgeMoment: string;
  detectedRisk: string | null;
  decision: BoardDecision["action"];
  evidencePointer: string;
  falsePositiveNotes: string;
  falseNegativeNotes: string;
}

function eventTurn(event: BoardEvent): number | undefined {
  return "turn" in event && typeof event.turn === "number" ? event.turn : undefined;
}

function stableRiskId(type: BoardRisk["type"], suffix: string): string {
  return `${type}:${suffix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "risk"}`;
}

function validationStatus(exitCode: number, status: "green" | "red" | "unknown"): "green" | "red" | "unknown" {
  if (status !== "unknown") return status;
  return exitCode === 0 ? "green" : "red";
}

export function buildBoardLedger(events: BoardEvent[]): BoardLedger {
  const session: BoardLedger["session"] = {};
  const changedFiles = new Set<string>();
  const changedFileTurns = new Map<string, number>();
  const evidence: EvidenceEpoch[] = [];
  const failureMap = new Map<string, FailureCluster>();
  const subagents: SubagentReturnSummary[] = [];
  let turns = 0;
  let lastProgressTurn: number | undefined;
  let lastChangeTurn: number | undefined;
  let lastValidationTurn: number | undefined;
  let costUsd = 0;

  for (const [index, event] of events.entries()) {
    const turn = eventTurn(event);
    const ordinalTurn = turn ?? turns + 1;
    turns = Math.max(turns, ordinalTurn);

    if (event.type === "session") {
      session.id = event.id;
      session.repo = event.repo;
      session.branch = event.branch;
      session.worktree = event.worktree;
      continue;
    }

    if (event.type === "turn") {
      costUsd += event.costUsd ?? 0;
      if (event.progress) lastProgressTurn = ordinalTurn;
      continue;
    }

    if (event.type === "file_changed") {
      changedFiles.add(event.path);
      lastChangeTurn = Math.max(lastChangeTurn ?? 0, ordinalTurn);
      changedFileTurns.set(event.path, Math.max(changedFileTurns.get(event.path) ?? 0, ordinalTurn));
      continue;
    }

    if (event.type === "validation") {
      const status = validationStatus(event.exitCode, event.status);
      lastValidationTurn = Math.max(lastValidationTurn ?? 0, ordinalTurn);
      if (status === "green") lastProgressTurn = Math.max(lastProgressTurn ?? 0, ordinalTurn);
      evidence.push({
        id: `validation:${index}`,
        kind: "validation",
        status,
        turn: ordinalTurn,
        timestamp: event.timestamp,
        summary: `${event.command} exited ${event.exitCode}`,
        terminal: event.terminal,
      });
      continue;
    }

    if (event.type === "tool_failure") {
      const clusterKey = `${event.tool}:${event.key}`;
      const cluster = failureMap.get(clusterKey) ?? {
        key: event.key,
        count: 0,
        firstTurn: ordinalTurn,
        lastTurn: ordinalTurn,
        tool: event.tool,
        messages: [],
      };
      cluster.count += 1;
      cluster.firstTurn = Math.min(cluster.firstTurn ?? ordinalTurn, ordinalTurn);
      cluster.lastTurn = Math.max(cluster.lastTurn ?? ordinalTurn, ordinalTurn);
      if (event.message) cluster.messages.push(event.message);
      failureMap.set(clusterKey, cluster);
      evidence.push({
        id: `failure:${clusterKey}:${cluster.count}`,
        kind: "tool_failure",
        status: "red",
        turn: ordinalTurn,
        timestamp: event.timestamp,
        summary: `${event.tool} failed: ${event.message ?? event.key}`,
      });
      continue;
    }

    if (event.type === "subagent_return") {
      if (event.verdict === "green") {
        lastProgressTurn = Math.max(lastProgressTurn ?? 0, ordinalTurn);
      }
      const summary: SubagentReturnSummary = {
        id: event.id,
        role: event.role,
        topic: event.topic,
        verdict: event.verdict,
        summary: event.summary,
        confidence: event.confidence,
        turn: ordinalTurn,
      };
      subagents.push(summary);
      evidence.push({
        id: `subagent:${event.id}`,
        kind: "subagent",
        status: event.verdict,
        turn: ordinalTurn,
        timestamp: event.timestamp,
        summary: `${event.role}: ${event.summary}`,
      });
    }
  }

  const ledger: BoardLedger = {
    session,
    changedFiles: [...changedFiles].sort(),
    changedFileTurns: Object.fromEntries([...changedFileTurns.entries()].sort(([a], [b]) => a.localeCompare(b))),
    evidence,
    failures: [...failureMap.values()].sort((a, b) => a.key.localeCompare(b.key)),
    subagents,
    progress: { turns, lastProgressTurn, lastChangeTurn, lastValidationTurn, costUsd },
    risks: [],
  };
  ledger.risks = detectBoardRisks(ledger);
  return ledger;
}

export function detectBoardRisks(ledger: BoardLedger): BoardRisk[] {
  const risks: BoardRisk[] = [];

  const redEvidence = ledger.evidence.filter((item) => item.status === "red");
  let terminalGreen: EvidenceEpoch | undefined;
  for (let index = ledger.evidence.length - 1; index >= 0; index--) {
    const item = ledger.evidence[index];
    if (item.status === "green" && item.terminal) {
      terminalGreen = item;
      break;
    }
  }
  if (terminalGreen) {
    const stale = redEvidence.filter((item) => (item.turn ?? -1) < (terminalGreen.turn ?? Number.MAX_SAFE_INTEGER));
    if (stale.length > 0) {
      risks.push({
        id: stableRiskId("stale_evidence", terminalGreen.id),
        type: "stale_evidence",
        severity: "important",
        evidence: `Newer terminal green evidence (${terminalGreen.summary}) supersedes ${stale.length} older red evidence item(s).`,
        evidencePointers: [terminalGreen.id, ...stale.map((item) => item.id)],
      });
    }
  }

  for (const failure of ledger.failures) {
    if (failure.count >= 3) {
      risks.push({
        id: stableRiskId("repeated_failure", `${failure.tool ?? "tool"}:${failure.key}`),
        type: "repeated_failure",
        severity: "important",
        evidence: `${failure.tool ?? "tool"} failure '${failure.key}' repeated ${failure.count} times.`,
        evidencePointers: [`failure:${failure.tool ?? "tool"}:${failure.key}`],
      });
    }
  }

  if (ledger.changedFiles.length > 0) {
    const lastChange = ledger.progress.lastChangeTurn ?? 0;
    const lastValidation = ledger.progress.lastValidationTurn ?? -1;
    const unvalidatedFiles = ledger.changedFiles.filter((file) => (ledger.changedFileTurns[file] ?? lastChange) > lastValidation);
    if (unvalidatedFiles.length > 0) {
      risks.push({
        id: stableRiskId("missing_validation", String(lastChange)),
        type: "missing_validation",
        severity: "important",
        evidence: `${unvalidatedFiles.length} changed file(s) after the last validation evidence.`,
        evidencePointers: unvalidatedFiles.map((file) => `file:${file}`),
      });
    }
  }

  const turnsSinceProgress = ledger.progress.turns - (ledger.progress.lastProgressTurn ?? 0);
  if (ledger.progress.turns >= 6 && turnsSinceProgress >= 5) {
    risks.push({
      id: stableRiskId("no_progress", String(ledger.progress.turns)),
      type: "no_progress",
      severity: "note",
      evidence: `${turnsSinceProgress} turn(s) since the last progress signal.`,
      evidencePointers: [`turn:${ledger.progress.turns}`],
    });
  }

  const byTopic = new Map<string, SubagentReturnSummary[]>();
  for (const item of ledger.subagents) {
    const topic = item.topic;
    if (!topic) continue;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), item]);
  }
  for (const [topic, items] of byTopic) {
    const verdicts = new Set(items.map((item) => item.verdict).filter((verdict) => verdict !== "unknown"));
    if (verdicts.has("green") && verdicts.has("red")) {
      risks.push({
        id: stableRiskId("subagent_contradiction", topic),
        type: "subagent_contradiction",
        severity: "important",
        evidence: `Subagents disagree on '${topic}'.`,
        evidencePointers: items.map((item) => `subagent:${item.id}`),
      });
    }
  }

  return risks;
}

export function decideBoardAction(ledger: BoardLedger): BoardDecision {
  if (ledger.risks.length === 0) return { action: "silent" };
  const blocker = ledger.risks.find((risk) => risk.severity === "blocker");
  if (blocker) {
    return { action: "would_whisper", severity: "blocker", reason: blocker.evidence, riskIds: [blocker.id] };
  }
  const important = ledger.risks.find((risk) => risk.severity === "important");
  if (important) {
    return { action: "would_whisper", severity: "important", reason: important.evidence, riskIds: [important.id] };
  }
  return { action: "ledger_update", riskIds: ledger.risks.map((risk) => risk.id) };
}

export function evaluateBoardFixture(fixture: BoardFixture): BoardEvalReportRow {
  const ledger = buildBoardLedger(fixture.events);
  const decision = decideBoardAction(ledger);
  const expected = fixture.expectedRiskTypes ?? [];
  const detectedTypes = new Set(ledger.risks.map((risk) => risk.type));
  const missing = expected.filter((type) => !detectedTypes.has(type));
  const unexpected = ledger.risks.filter((risk) => expected.length === 0 || !expected.includes(risk.type));
  const firstRisk = ledger.risks[0];
  return {
    fixtureId: fixture.id,
    expectedEdgeMoment: fixture.expectedEdgeMoment,
    detectedRisk: firstRisk?.type ?? null,
    decision: decision.action,
    evidencePointer: firstRisk?.evidencePointers[0] ?? "",
    falsePositiveNotes: unexpected.length > 0 ? `unexpected: ${unexpected.map((risk) => risk.type).join(",")}` : "",
    falseNegativeNotes: missing.length > 0 ? `missing: ${missing.join(",")}` : "",
  };
}

export function evaluateBoardFixtures(fixtures: BoardFixture[]): BoardEvalReportRow[] {
  return fixtures.map(evaluateBoardFixture);
}
