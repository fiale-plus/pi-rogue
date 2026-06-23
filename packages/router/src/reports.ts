import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readTrainingRows } from "./binary-gate.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import { readOutcomes, type RouterOutcome } from "./outcomes.js";

export const ROUTER_REPORT_SCHEMA = "pi-router.report.v1" as const;

export interface RouterReport {
  schema: typeof ROUTER_REPORT_SCHEMA;
  generatedAt: string;
  inputs: { events?: string; outcomes?: string; gateReport?: string; trainingRows?: string };
  routeEvents: { total: number; byAction: Record<string, number>; byModel: Record<string, number>; mismatches: number };
  outcomes: { total: number; byStatus: Record<string, number>; byBlockedBy: Record<string, number>; linked: number; missingEvidence: number };
  trainingRows: { total: number; labeled: number; unlabeled: number; localRuleExcluded: number; byGate: Record<string, number> };
  gate?: unknown;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function routeSummary(events: RouteEvent[]): RouterReport["routeEvents"] {
  const byAction: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let mismatches = 0;
  for (const event of events) {
    increment(byAction, event.decision.action);
    increment(byModel, event.runtime.activeModel ?? "unknown");
    if (event.observed.followed === false || event.observed.overriddenBy) mismatches++;
  }
  return { total: events.length, byAction, byModel, mismatches };
}

function outcomeSummary(outcomes: RouterOutcome[]): RouterReport["outcomes"] {
  const byStatus: Record<string, number> = {};
  const byBlockedBy: Record<string, number> = {};
  let linked = 0;
  let missingEvidence = 0;
  for (const outcome of outcomes) {
    increment(byStatus, outcome.taskStatus);
    if (outcome.evidence.blockedBy) increment(byBlockedBy, outcome.evidence.blockedBy);
    if (outcome.routeEventId || outcome.checkpointId) linked++;
    if (!outcome.evidence.rawSessionRef && !outcome.evidence.notesHash) missingEvidence++;
  }
  return { total: outcomes.length, byStatus, byBlockedBy, linked, missingEvidence };
}

function trainingSummary(rowsPath?: string): RouterReport["trainingRows"] {
  if (!rowsPath) return { total: 0, labeled: 0, unlabeled: 0, localRuleExcluded: 0, byGate: {} };
  const rows = readTrainingRows(rowsPath);
  const byGate: Record<string, number> = {};
  let labeled = 0;
  let localRuleExcluded = 0;
  for (const row of rows) {
    increment(byGate, row.labels.binaryGate);
    if (row.labels.binaryGate === "unknown") localRuleExcluded += row.provenance.excludedLocalRuleAsTruth ? 1 : 0;
    else labeled++;
  }
  return { total: rows.length, labeled, unlabeled: rows.length - labeled, localRuleExcluded, byGate };
}

function readJson(path?: string): unknown {
  if (!path) return undefined;
  if (!existsSync(resolve(path))) throw new Error(`report input file not found: ${path}`);
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function markdown(report: RouterReport): string {
  const gate = report.gate && typeof report.gate === "object" ? report.gate as { candidate?: { accuracy?: number; f1?: number }; ruleBaseline?: { accuracy?: number; f1?: number } } : undefined;
  const lines = [
    "# Pi router report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- route events: ${report.routeEvents.total}`,
    `- route mismatches/overrides: ${report.routeEvents.mismatches}`,
    `- outcomes: ${report.outcomes.total}`,
    `- route-blocked by: ${Object.entries(report.outcomes.byBlockedBy).sort().map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `- training rows: ${report.trainingRows.total} (${report.trainingRows.labeled} labeled, ${report.trainingRows.unlabeled} unlabeled)`,
    `- local-rule labels excluded: ${report.trainingRows.localRuleExcluded}`,
    "",
    "## Route actions",
    ...Object.entries(report.routeEvents.byAction).sort().map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Outcome status",
    ...Object.entries(report.outcomes.byStatus).sort().map(([key, value]) => `- ${key}: ${value}`),
  ];
  if (gate) {
    lines.push("", "## Gate eval", `- candidate accuracy/f1: ${gate.candidate?.accuracy ?? "n/a"}/${gate.candidate?.f1 ?? "n/a"}`, `- rule baseline accuracy/f1: ${gate.ruleBaseline?.accuracy ?? "n/a"}/${gate.ruleBaseline?.f1 ?? "n/a"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildRouterReport(options: { eventsPath?: string; outcomesPath?: string; trainingRowsPath?: string; gateReportPath?: string; generatedAt?: string }): RouterReport {
  if (options.eventsPath && !existsSync(resolve(options.eventsPath))) throw new Error(`report input file not found: ${options.eventsPath}`);
  const events = options.eventsPath ? readRouteEvents(options.eventsPath) : [];
  const outcomes = options.outcomesPath ? readOutcomes(options.outcomesPath) : [];
  return {
    schema: ROUTER_REPORT_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    inputs: { events: options.eventsPath, outcomes: options.outcomesPath, trainingRows: options.trainingRowsPath, gateReport: options.gateReportPath },
    routeEvents: routeSummary(events),
    outcomes: outcomeSummary(outcomes),
    trainingRows: trainingSummary(options.trainingRowsPath),
    gate: readJson(options.gateReportPath),
  };
}

export function writeRouterReport(options: { outputPath: string; markdownPath?: string; eventsPath?: string; outcomesPath?: string; trainingRowsPath?: string; gateReportPath?: string }): RouterReport {
  if (!options.eventsPath && !options.outcomesPath && !options.trainingRowsPath && !options.gateReportPath) throw new Error("router report requires at least one input file");
  const report = buildRouterReport(options);
  mkdirSync(dirname(resolve(options.outputPath)), { recursive: true });
  writeFileSync(resolve(options.outputPath), `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdownPath) {
    mkdirSync(dirname(resolve(options.markdownPath)), { recursive: true });
    writeFileSync(resolve(options.markdownPath), markdown(report));
  }
  return report;
}
