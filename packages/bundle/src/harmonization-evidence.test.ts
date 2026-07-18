import { describe, expect, it } from "vitest";
import {
  HARMONIZATION_EVIDENCE_FIXTURES,
  HARMONIZATION_EVIDENCE_SCHEMA,
  aggregateHarmonizationEvidence,
  buildHarmonizationEvidencePack,
  serializeHarmonizationEvidence,
  serializeHarmonizationEvidenceCsv,
  validateHarmonizationEvidence,
} from "../../../scripts/harmonization-evidence.js";

describe("harmonization evidence pack", () => {
  it("emits deterministic, stratified, aggregate-only evidence", () => {
    const first = buildHarmonizationEvidencePack();
    const second = buildHarmonizationEvidencePack();

    expect(HARMONIZATION_EVIDENCE_FIXTURES).toHaveLength(24);
    expect(first).toEqual(second);
    expect(first.schema).toBe(HARMONIZATION_EVIDENCE_SCHEMA);
    expect(first.recordCount).toBe(24);
    expect(first.aggregates.byFeature).toEqual({ router: 6, advisor: 6, orchestration: 6, "context-broker": 6 });
    expect(first.aggregates.acceptedOutcome).toEqual({ accepted: 16, not_accepted: 4, unknown: 4 });
    expect(first.aggregates.escalation.true_positive).toBe(4);
    expect(first.aggregates.escalation.false_positive).toBe(4);
    expect(first.aggregates.rework).toEqual({ zero: 12, one: 8, twoOrMore: 4, total: 16 });
    expect(first.aggregates.usage).toEqual({ commandUsed: 12, configurationUsed: 12 });
    expect(serializeHarmonizationEvidence(first)).toBe(serializeHarmonizationEvidence(second));
    expect(JSON.stringify(first)).not.toMatch(/prompt|transcript|payload|secret|user|path|content/i);
  });

  it("validates empty input and emits a stable CSV projection", () => {
    expect(aggregateHarmonizationEvidence([]).recordCount).toBe(0);
    const csv = serializeHarmonizationEvidenceCsv(HARMONIZATION_EVIDENCE_FIXTURES);
    expect(csv.split("\n")).toHaveLength(25);
    expect(csv.split("\n")[0]).toContain("fixture_id,feature,sample_class");
    expect(csv).toContain("fixture-router-explicit-route,router,explicit_route");
  });

  it("fails closed on prohibited, unknown, malformed, and duplicate records", () => {
    const record = HARMONIZATION_EVIDENCE_FIXTURES[0];
    expect(() => validateHarmonizationEvidence([{ ...record, prompt: "never store this" }])).toThrow(/prohibited field/);
    expect(() => validateHarmonizationEvidence([{ ...record, unexpected: true }])).toThrow(/unknown field/);
    expect(() => validateHarmonizationEvidence([{ ...record, reworkCount: 8 }])).toThrow(/integer from 0 through 3/);
    expect(() => validateHarmonizationEvidence([record, record])).toThrow(/duplicate fixture identifier/);
    expect(() => validateHarmonizationEvidence({ schema: HARMONIZATION_EVIDENCE_SCHEMA, records: [record], rawContent: "no" })).toThrow(/prohibited field/);
    const pack = buildHarmonizationEvidencePack();
    expect(() => validateHarmonizationEvidence({ ...pack, aggregates: { ...pack.aggregates, prompt: "no" } })).toThrow(/aggregates/);
    expect(() => validateHarmonizationEvidence({ ...pack, recordCount: 1 })).toThrow(/recordCount/);
  });
});
