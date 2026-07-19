#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HARMONIZATION_EVIDENCE_SCHEMA = "pi-rogue.harmonization-evidence.v1" as const;

export type EvidenceFeature = "router" | "advisor" | "orchestration" | "context-broker";
export type EvidenceBand = "none" | "low" | "medium" | "high" | "unknown";
export type AcceptedOutcome = "accepted" | "not_accepted" | "unknown";
export type EscalationLabel = "not_applicable" | "true_positive" | "true_negative" | "false_positive" | "false_negative" | "unknown";
export type EscalationReason = "none" | "difficulty" | "mismatch" | "failure" | "policy" | "unknown";
export type FallbackClass = "none" | "provider_failure" | "worker_timeout" | "safe_local" | "unknown";
export type BrokerAvailability = "used" | "not_used" | "unavailable";
export type SampleClass = "explicit_route" | "default_route" | "accepted_escalation" | "rejected_escalation" | "fallback_recovery" | "missing_evidence";

export interface HarmonizationEvidenceRecord {
  fixtureId: string;
  feature: EvidenceFeature;
  sampleClass: SampleClass;
  acceptedOutcome: AcceptedOutcome;
  cost: {
    tokenBand: EvidenceBand;
    callBand: EvidenceBand;
    spendBand: EvidenceBand;
  };
  escalation: {
    label: EscalationLabel;
    reason: EscalationReason;
  };
  reworkCount: number;
  fallback: FallbackClass;
  usage: {
    commandUsed: boolean;
    configurationUsed: boolean;
  };
  contextBroker: {
    availability: BrokerAvailability;
    savingsBand: EvidenceBand;
  };
}

export interface HarmonizationEvidenceAggregate {
  recordCount: number;
  byFeature: Record<EvidenceFeature, number>;
  acceptedOutcome: Record<AcceptedOutcome, number>;
  escalation: Record<EscalationLabel, number>;
  escalationReasons: Record<EscalationReason, number>;
  rework: { zero: number; one: number; twoOrMore: number; total: number };
  fallback: Record<FallbackClass, number>;
  usage: { commandUsed: number; configurationUsed: number };
  contextBroker: {
    availability: Record<BrokerAvailability, number>;
    savingsBand: Record<EvidenceBand, number>;
  };
  cost: {
    tokenBand: Record<EvidenceBand, number>;
    callBand: Record<EvidenceBand, number>;
    spendBand: Record<EvidenceBand, number>;
  };
}

export interface HarmonizationEvidencePack {
  schema: typeof HARMONIZATION_EVIDENCE_SCHEMA;
  recordCount: number;
  records: HarmonizationEvidenceRecord[];
  aggregates: HarmonizationEvidenceAggregate;
}

type EvidenceSeed = Omit<HarmonizationEvidenceRecord, "fixtureId" | "feature">;

const FEATURES: readonly EvidenceFeature[] = ["router", "advisor", "orchestration", "context-broker"];
const SEEDS: readonly EvidenceSeed[] = [
  {
    sampleClass: "explicit_route",
    acceptedOutcome: "accepted",
    cost: { tokenBand: "low", callBand: "low", spendBand: "low" },
    escalation: { label: "true_negative", reason: "none" },
    reworkCount: 0,
    fallback: "none",
    usage: { commandUsed: true, configurationUsed: false },
    contextBroker: { availability: "used", savingsBand: "medium" },
  },
  {
    sampleClass: "default_route",
    acceptedOutcome: "accepted",
    cost: { tokenBand: "low", callBand: "low", spendBand: "low" },
    escalation: { label: "true_negative", reason: "none" },
    reworkCount: 0,
    fallback: "none",
    usage: { commandUsed: false, configurationUsed: true },
    contextBroker: { availability: "used", savingsBand: "low" },
  },
  {
    sampleClass: "accepted_escalation",
    acceptedOutcome: "accepted",
    cost: { tokenBand: "high", callBand: "medium", spendBand: "high" },
    escalation: { label: "true_positive", reason: "difficulty" },
    reworkCount: 1,
    fallback: "none",
    usage: { commandUsed: true, configurationUsed: true },
    contextBroker: { availability: "used", savingsBand: "high" },
  },
  {
    sampleClass: "rejected_escalation",
    acceptedOutcome: "not_accepted",
    cost: { tokenBand: "medium", callBand: "medium", spendBand: "medium" },
    escalation: { label: "false_positive", reason: "mismatch" },
    reworkCount: 2,
    fallback: "none",
    usage: { commandUsed: true, configurationUsed: false },
    contextBroker: { availability: "used", savingsBand: "low" },
  },
  {
    sampleClass: "fallback_recovery",
    acceptedOutcome: "accepted",
    cost: { tokenBand: "high", callBand: "high", spendBand: "medium" },
    escalation: { label: "false_negative", reason: "failure" },
    reworkCount: 1,
    fallback: "provider_failure",
    usage: { commandUsed: false, configurationUsed: true },
    contextBroker: { availability: "unavailable", savingsBand: "unknown" },
  },
  {
    sampleClass: "missing_evidence",
    acceptedOutcome: "unknown",
    cost: { tokenBand: "unknown", callBand: "unknown", spendBand: "unknown" },
    escalation: { label: "unknown", reason: "unknown" },
    reworkCount: 0,
    fallback: "unknown",
    usage: { commandUsed: false, configurationUsed: false },
    contextBroker: { availability: "not_used", savingsBand: "unknown" },
  },
];

export const HARMONIZATION_EVIDENCE_FIXTURES: readonly HarmonizationEvidenceRecord[] = FEATURES.flatMap((feature) =>
  SEEDS.map((seed) => ({
    fixtureId: `fixture-${feature.replaceAll("_", "-")}-${seed.sampleClass.replaceAll("_", "-")}`,
    feature,
    ...seed,
  })),
);

const BAND_VALUES: readonly EvidenceBand[] = ["none", "low", "medium", "high", "unknown"];
const ACCEPTED_VALUES: readonly AcceptedOutcome[] = ["accepted", "not_accepted", "unknown"];
const ESCALATION_VALUES: readonly EscalationLabel[] = ["not_applicable", "true_positive", "true_negative", "false_positive", "false_negative", "unknown"];
const ESCALATION_REASON_VALUES: readonly EscalationReason[] = ["none", "difficulty", "mismatch", "failure", "policy", "unknown"];
const FALLBACK_VALUES: readonly FallbackClass[] = ["none", "provider_failure", "worker_timeout", "safe_local", "unknown"];
const AVAILABILITY_VALUES: readonly BrokerAvailability[] = ["used", "not_used", "unavailable"];
const SAMPLE_VALUES: readonly SampleClass[] = ["explicit_route", "default_route", "accepted_escalation", "rejected_escalation", "fallback_recovery", "missing_evidence"];
const FEATURE_VALUES: readonly EvidenceFeature[] = [...FEATURES];

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${path}: symbol field is not allowed`);
    if (/prompt|transcript|payload|path|secret|credential|password|user|email|raw|content|filesystem/i.test(key)) {
      throw new Error(`${path}.${key}: prohibited field`);
    }
    if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown field`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${path}.${key}: required field missing`);
  }
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], path: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${path}: invalid value`);
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
}

function assertInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3) throw new Error(`${path}: expected integer from 0 through 3`);
}

function validateRecord(value: unknown, index: number): HarmonizationEvidenceRecord {
  const path = `records[${index}]`;
  if (!isRecord(value)) throw new Error(`${path}: expected object`);
  assertKeys(value, ["fixtureId", "feature", "sampleClass", "acceptedOutcome", "cost", "escalation", "reworkCount", "fallback", "usage", "contextBroker"], path);
  const fixtureMatch = typeof value.fixtureId === "string"
    ? value.fixtureId.match(/^fixture-(router|advisor|orchestration|context-broker)-(explicit-route|default-route|accepted-escalation|rejected-escalation|fallback-recovery|missing-evidence)$/)
    : null;
  if (!fixtureMatch) throw new Error(`${path}.fixtureId: invalid or non-opaque fixture identifier`);
  assertEnum(value.feature, FEATURE_VALUES, `${path}.feature`);
  assertEnum(value.sampleClass, SAMPLE_VALUES, `${path}.sampleClass`);
  if (fixtureMatch[1] !== value.feature || fixtureMatch[2] !== value.sampleClass.replaceAll("_", "-")) {
    throw new Error(`${path}.fixtureId: does not match feature or sample class`);
  }
  assertEnum(value.acceptedOutcome, ACCEPTED_VALUES, `${path}.acceptedOutcome`);
  if (!isRecord(value.cost)) throw new Error(`${path}.cost: expected object`);
  assertKeys(value.cost, ["tokenBand", "callBand", "spendBand"], `${path}.cost`);
  assertEnum(value.cost.tokenBand, BAND_VALUES, `${path}.cost.tokenBand`);
  assertEnum(value.cost.callBand, BAND_VALUES, `${path}.cost.callBand`);
  assertEnum(value.cost.spendBand, BAND_VALUES, `${path}.cost.spendBand`);
  if (!isRecord(value.escalation)) throw new Error(`${path}.escalation: expected object`);
  assertKeys(value.escalation, ["label", "reason"], `${path}.escalation`);
  assertEnum(value.escalation.label, ESCALATION_VALUES, `${path}.escalation.label`);
  assertEnum(value.escalation.reason, ESCALATION_REASON_VALUES, `${path}.escalation.reason`);
  assertInteger(value.reworkCount, `${path}.reworkCount`);
  assertEnum(value.fallback, FALLBACK_VALUES, `${path}.fallback`);
  if (!isRecord(value.usage)) throw new Error(`${path}.usage: expected object`);
  assertKeys(value.usage, ["commandUsed", "configurationUsed"], `${path}.usage`);
  assertBoolean(value.usage.commandUsed, `${path}.usage.commandUsed`);
  assertBoolean(value.usage.configurationUsed, `${path}.usage.configurationUsed`);
  if (!isRecord(value.contextBroker)) throw new Error(`${path}.contextBroker: expected object`);
  assertKeys(value.contextBroker, ["availability", "savingsBand"], `${path}.contextBroker`);
  assertEnum(value.contextBroker.availability, AVAILABILITY_VALUES, `${path}.contextBroker.availability`);
  assertEnum(value.contextBroker.savingsBand, BAND_VALUES, `${path}.contextBroker.savingsBand`);
  return value as unknown as HarmonizationEvidenceRecord;
}

export function validateHarmonizationEvidence(input: unknown): HarmonizationEvidenceRecord[] {
  let records: unknown[] | undefined;
  if (Array.isArray(input)) {
    records = input;
  } else if (isRecord(input) && Array.isArray(input.records)) {
    assertKeys(input, ["schema", "recordCount", "records", "aggregates"], "evidence");
    if (input.schema !== HARMONIZATION_EVIDENCE_SCHEMA) throw new Error("evidence.schema: invalid schema");
    records = input.records;
  }
  if (!records) throw new Error("evidence input: expected an array or evidence pack with a records array");
  const validated = records.map(validateRecord);
  const ids = new Set<string>();
  for (const record of validated) {
    if (ids.has(record.fixtureId)) throw new Error(`records.${record.fixtureId}: duplicate fixture identifier`);
    ids.add(record.fixtureId);
  }
  if (isRecord(input) && Array.isArray(input.records)) {
    if (input.recordCount !== undefined && input.recordCount !== validated.length) throw new Error("evidence.recordCount: does not match records");
    if (input.aggregates !== undefined && JSON.stringify(canonicalize(input.aggregates)) !== JSON.stringify(canonicalize(aggregateValidated(validated)))) {
      throw new Error("evidence.aggregates: does not match records");
    }
  }
  return validated;
}

function counts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function aggregateValidated(records: HarmonizationEvidenceRecord[]): HarmonizationEvidenceAggregate {
  const result: HarmonizationEvidenceAggregate = {
    recordCount: records.length,
    byFeature: counts(FEATURE_VALUES),
    acceptedOutcome: counts(ACCEPTED_VALUES),
    escalation: counts(ESCALATION_VALUES),
    escalationReasons: counts(ESCALATION_REASON_VALUES),
    rework: { zero: 0, one: 0, twoOrMore: 0, total: 0 },
    fallback: counts(FALLBACK_VALUES),
    usage: { commandUsed: 0, configurationUsed: 0 },
    contextBroker: { availability: counts(AVAILABILITY_VALUES), savingsBand: counts(BAND_VALUES) },
    cost: { tokenBand: counts(BAND_VALUES), callBand: counts(BAND_VALUES), spendBand: counts(BAND_VALUES) },
  };
  for (const record of records) {
    result.byFeature[record.feature] += 1;
    result.acceptedOutcome[record.acceptedOutcome] += 1;
    result.escalation[record.escalation.label] += 1;
    result.escalationReasons[record.escalation.reason] += 1;
    result.rework.total += record.reworkCount;
    if (record.reworkCount === 0) result.rework.zero += 1;
    else if (record.reworkCount === 1) result.rework.one += 1;
    else result.rework.twoOrMore += 1;
    result.fallback[record.fallback] += 1;
    if (record.usage.commandUsed) result.usage.commandUsed += 1;
    if (record.usage.configurationUsed) result.usage.configurationUsed += 1;
    result.contextBroker.availability[record.contextBroker.availability] += 1;
    result.contextBroker.savingsBand[record.contextBroker.savingsBand] += 1;
    result.cost.tokenBand[record.cost.tokenBand] += 1;
    result.cost.callBand[record.cost.callBand] += 1;
    result.cost.spendBand[record.cost.spendBand] += 1;
  }
  return result;
}

export function aggregateHarmonizationEvidence(input: unknown): HarmonizationEvidenceAggregate {
  return aggregateValidated(validateHarmonizationEvidence(input));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
}

export function buildHarmonizationEvidencePack(input: unknown = HARMONIZATION_EVIDENCE_FIXTURES): HarmonizationEvidencePack {
  const records = validateHarmonizationEvidence(input);
  return {
    schema: HARMONIZATION_EVIDENCE_SCHEMA,
    recordCount: records.length,
    records,
    aggregates: aggregateHarmonizationEvidence(records),
  };
}

export function serializeHarmonizationEvidence(pack: HarmonizationEvidencePack): string {
  return JSON.stringify(canonicalize(buildHarmonizationEvidencePack(pack)));
}

const CSV_COLUMNS = [
  "fixture_id", "feature", "sample_class", "accepted_outcome", "token_band", "call_band", "spend_band",
  "escalation_label", "escalation_reason", "rework_count", "fallback", "command_used", "configuration_used",
  "broker_availability", "broker_savings_band",
] as const;

function csvValue(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeHarmonizationEvidenceCsv(input: unknown): string {
  const records = validateHarmonizationEvidence(input);
  const rows = records.map((record) => [
    record.fixtureId, record.feature, record.sampleClass, record.acceptedOutcome, record.cost.tokenBand, record.cost.callBand, record.cost.spendBand,
    record.escalation.label, record.escalation.reason, record.reworkCount, record.fallback, record.usage.commandUsed, record.usage.configurationUsed,
    record.contextBroker.availability, record.contextBroker.savingsBand,
  ].map(csvValue).join(","));
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

function cliValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const inputPath = cliValue(argv, "--input");
  const outputPath = cliValue(argv, "--output");
  const format = cliValue(argv, "--format") ?? "json";
  if (format !== "json" && format !== "csv") throw new Error(`unsupported evidence format: ${format}`);
  const input = inputPath ? JSON.parse(readFileSync(inputPath, "utf8")) as unknown : HARMONIZATION_EVIDENCE_FIXTURES;
  const output = format === "csv"
    ? `${serializeHarmonizationEvidenceCsv(input)}\n`
    : `${serializeHarmonizationEvidence(buildHarmonizationEvidencePack(input))}\n`;
  if (outputPath) writeFileSync(outputPath, output, "utf8");
  else process.stdout.write(output);
}
