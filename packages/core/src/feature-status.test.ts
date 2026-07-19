import { describe, expect, it } from "vitest";
import { createFeatureStatusV1, serializeFeatureStatusV1, validateFeatureStatusV1 } from "./feature-status.js";

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
    expect(() => validateFeatureStatusV1(status)).not.toThrow();
  });

  it("fails closed for prohibited diagnostics and unknown top-level fields", () => {
    const status = createFeatureStatusV1({ feature: "router", owner: "router", health: "idle", enabled: true });
    expect(() => serializeFeatureStatusV1({ ...status, diagnostics: { prompt: "no" } })).toThrow(/prohibited field/);
    expect(() => serializeFeatureStatusV1({ ...status, diagnostics: { detail: "/private/user/secret" } })).toThrow(/unsafe or unbounded text/);
    expect(() => validateFeatureStatusV1({ ...status, unknown: true } as typeof status)).toThrow(/unknown field/);
    const inherited = Object.create({ health: "ready" });
    Object.assign(inherited, { schema: "FeatureStatusV1", feature: "router", owner: "router", enabled: true });
    expect(() => validateFeatureStatusV1(inherited)).toThrow(/expected a plain object/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeFeatureStatusV1({ ...status, diagnostics: cyclic })).toThrow(/cyclic diagnostics/);
  });
});
