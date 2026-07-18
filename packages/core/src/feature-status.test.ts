import { describe, expect, it } from "vitest";
import { createFeatureStatusV1, serializeFeatureStatusV1 } from "./feature-status.js";

describe("FeatureStatusV1", () => {
  it("creates a versioned passive snapshot", () => {
    expect(createFeatureStatusV1({
      feature: "router",
      owner: "router",
      health: "disabled",
      enabled: false,
      mode: "observe",
    })).toEqual({
      schema: "FeatureStatusV1",
      feature: "router",
      owner: "router",
      health: "disabled",
      enabled: false,
      mode: "observe",
    });
  });

  it("keeps the schema marker authoritative", () => {
    const input = { feature: "router", owner: "router", health: "idle" as const, enabled: true, schema: "WrongSchema" };
    expect(createFeatureStatusV1(input as any).schema).toBe("FeatureStatusV1");
  });

  it("serializes nested diagnostics with stable key ordering", () => {
    const status = createFeatureStatusV1({
      feature: "orchestration",
      owner: "orchestration",
      health: "ready",
      enabled: true,
      diagnostics: { z: 1, a: { y: true, b: [ { d: 1, c: 2 } ] }, ä: 3 },
    });
    expect(serializeFeatureStatusV1(status)).toBe(
      '{"diagnostics":{"a":{"b":[{"c":2,"d":1}],"y":true},"z":1,"ä":3},"enabled":true,"feature":"orchestration","health":"ready","owner":"orchestration","schema":"FeatureStatusV1"}',
    );
  });

  it("keeps feature-owned unknown diagnostics additive", () => {
    const status = createFeatureStatusV1({
      feature: "future",
      owner: "future",
      health: "degraded",
      enabled: true,
      diagnostics: { futureField: "ignored by older consumers" },
    });
    expect(status.diagnostics?.futureField).toBe("ignored by older consumers");
  });
});
