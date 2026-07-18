import { describe, expect, it } from "vitest";
import {
  HARMONIZATION_FIXTURES,
  HARMONIZATION_MEASUREMENT_SCHEMA,
  runHarmonizationMeasurement,
  serializeHarmonizationMeasurement,
} from "../../../scripts/harmonization-measurement.js";

describe("harmonization measurement harness", () => {
  it("runs deterministic, redacted observations for every fixture", () => {
    const first = runHarmonizationMeasurement();
    const second = runHarmonizationMeasurement();

    expect(first).toEqual(second);
    expect(first.schema).toBe(HARMONIZATION_MEASUREMENT_SCHEMA);
    expect(first.observations).toHaveLength(HARMONIZATION_FIXTURES.length);
    expect(serializeHarmonizationMeasurement(first)).toBe(serializeHarmonizationMeasurement(second));
    expect(JSON.stringify(first)).not.toContain("fixture worker result");
    expect(JSON.stringify(first)).not.toContain("/tmp/");
  });

  it("covers explicit/default routes, unknown features, optional inputs, and correlation conflicts", () => {
    const report = runHarmonizationMeasurement();
    const byId = new Map(report.observations.map((observation) => [observation.fixtureId, observation]));

    expect(byId.get("router-decision-explicit-review")).toMatchObject({
      route: "explicit",
      authority: "router",
      response: { action: "escalate_diff_review" },
    });
    expect(byId.get("router-status-unconfigured")).toMatchObject({
      defaults: { sessionScoped: false },
    });
    expect(byId.get("router-status-malformed")).toMatchObject({
      authority: "router",
      response: { health: "error" },
      defaults: { stateValid: false },
    });
    expect(byId.get("router-decision-default-local")).toMatchObject({
      route: "default",
      authority: "router",
      response: { action: "continue_local" },
    });
    expect(byId.get("unknown-feature")).toMatchObject({ response: { status: "unknown_feature" }, authority: "none" });
    expect(byId.get("advisor-worker-review-minimal")).toMatchObject({ request: { optionalInput: "absent", correlationConflict: false } });
    expect(byId.get("advisor-worker-review-empty-optional")).toMatchObject({ request: { optionalInput: "empty", correlationConflict: false } });
    expect(byId.get("advisor-worker-review-conflicting-correlation")).toMatchObject({
      request: { correlationConflict: true },
      correlation: { conflict: true, sessionIdHash: expect.any(String), repoHash: expect.any(String) },
    });
    expect(byId.get("context-source-optional-absent")).toMatchObject({ response: { sourceIdHash: null }, defaults: { sourceIdPresent: false } });
    expect(byId.get("context-source-explicit")).toMatchObject({ response: { sourceIdHash: expect.any(String) }, defaults: { sourceIdPresent: true, sourceIdValidated: true } });
  });

  it("is inert when disabled", () => {
    expect(runHarmonizationMeasurement(false)).toEqual({
      schema: HARMONIZATION_MEASUREMENT_SCHEMA,
      harnessEnabled: false,
      observations: [],
    });
  });
});
