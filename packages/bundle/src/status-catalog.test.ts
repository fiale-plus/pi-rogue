import { describe, expect, it } from "vitest";
import { createFeatureStatusV1 } from "@fiale-plus/pi-core";
import {
  createHarmonizationStatusCatalog,
  HARMONIZATION_STATUS_CATALOG_SCHEMA,
  serializeHarmonizationStatusCatalog,
} from "./status-catalog.js";

const status = (feature: string, health: "idle" | "ready" = "idle") => createFeatureStatusV1({
  feature,
  owner: feature,
  health,
  enabled: true,
  mode: health,
});

describe("harmonization status catalog", () => {
  it("keeps explicit registration order and uses only passive providers", () => {
    const calls: string[] = [];
    const catalog = createHarmonizationStatusCatalog({}, {
      advisor: () => { calls.push("advisor"); return status("advisor"); },
      router: () => { calls.push("router"); return status("router", "ready"); },
      orchestration: () => { calls.push("orchestration"); return status("orchestration"); },
      contextBroker: () => { calls.push("context-broker"); return { enabled: true, registered: true, durable: false, backend: "memory" }; },
    });

    expect(calls).toEqual(["advisor", "router", "orchestration", "context-broker"]);
    expect(catalog).toMatchObject({
      schema: HARMONIZATION_STATUS_CATALOG_SCHEMA,
      features: [
        { feature: "advisor" },
        { feature: "router", health: "ready" },
        { feature: "orchestration" },
        { feature: "context-broker", health: "ready", mode: "memory" },
      ],
    });
  });

  it("converts adapter failures into an explicit error status", () => {
    const catalog = createHarmonizationStatusCatalog({}, {
      advisor: () => { throw new Error("raw failure must not escape"); },
    });
    expect(catalog.features[0]).toMatchObject({ feature: "advisor", health: "error", enabled: false, diagnostics: { adapterError: true } });
    expect(JSON.stringify(catalog)).not.toContain("raw failure");
  });

  it("serializes only the canonical, privacy-checked catalog", () => {
    const catalog = createHarmonizationStatusCatalog({}, {
      advisor: () => status("advisor"),
      router: () => status("router"),
      orchestration: () => status("orchestration"),
      contextBroker: () => ({ enabled: false, registered: false }),
    });
    const first = serializeHarmonizationStatusCatalog(catalog);
    expect(first).toBe(serializeHarmonizationStatusCatalog(JSON.parse(first)));
    expect(first).not.toContain("/");
    expect(() => serializeHarmonizationStatusCatalog({ ...catalog, features: [{ ...catalog.features[0], diagnostics: { prompt: "secret" } }, ...catalog.features.slice(1)] })).toThrow(/prohibited field/);
  });
});
