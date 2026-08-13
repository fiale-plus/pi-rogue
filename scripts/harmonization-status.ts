import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createFeatureStatusV1, type FeatureStatusV1 } from "../packages/core/src/feature-status.js";
import {
  createHarmonizationStatusCatalog,
  serializeHarmonizationStatusCatalog,
  type HarmonizationStatusCatalogV1,
} from "../packages/bundle/src/status-catalog.js";

export const HARMONIZATION_STATUS_FIXTURES: readonly FeatureStatusV1[] = [
  createFeatureStatusV1({ feature: "advisor", owner: "advisor", health: "ready", enabled: true, mode: "auto" }),
  createFeatureStatusV1({ feature: "router", owner: "router", health: "idle", enabled: true, mode: "observe" }),
  createFeatureStatusV1({ feature: "orchestration", owner: "orchestration", health: "disabled", enabled: false, mode: "idle" }),
  createFeatureStatusV1({ feature: "context-broker", owner: "context-broker", health: "ready", enabled: true, mode: "sqlite", diagnostics: { registered: true, durable: true, backend: "sqlite" } }),
];

export function runHarmonizationStatusReport(): HarmonizationStatusCatalogV1 {
  return createHarmonizationStatusCatalog({}, {
    advisor: () => HARMONIZATION_STATUS_FIXTURES[0],
    router: () => HARMONIZATION_STATUS_FIXTURES[1],
    orchestration: () => HARMONIZATION_STATUS_FIXTURES[2],
    contextBroker: () => ({ enabled: true, registered: true, durable: true, backend: "sqlite" }),
  });
}

export function serializeHarmonizationStatusReport(report: HarmonizationStatusCatalogV1): string {
  return serializeHarmonizationStatusCatalog(report);
}

function cliValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = cliValue(process.argv.slice(2), "--output");
  const serialized = serializeHarmonizationStatusReport(runHarmonizationStatusReport());
  if (output) writeFileSync(output, `${serialized}\n`, "utf8");
  else process.stdout.write(`${serialized}\n`);
}
