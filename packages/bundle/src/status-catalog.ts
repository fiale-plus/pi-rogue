import {
  createFeatureStatusV1,
  serializeFeatureStatusV1,
  validateFeatureStatusV1,
  type FeatureStatusV1,
} from "@fiale-plus/pi-core";
import { advisorFeatureStatus } from "@fiale-plus/pi-rogue-advisor";
import { contextBrokerFeatureStatus, type ContextBrokerStatusSource } from "@fiale-plus/pi-rogue-context-broker";
import { orchestrationFeatureStatus } from "@fiale-plus/pi-rogue-orchestration";
import { routerFeatureStatus } from "@fiale-plus/pi-rogue-router";

export const HARMONIZATION_STATUS_CATALOG_SCHEMA = "pi-rogue.harmonization-status.v1" as const;

export interface HarmonizationStatusCatalogV1 {
  schema: typeof HARMONIZATION_STATUS_CATALOG_SCHEMA;
  features: FeatureStatusV1[];
}

export type FeatureStatusProvider = (ctx: unknown) => FeatureStatusV1;

export interface HarmonizationStatusSources {
  advisor?: FeatureStatusProvider;
  router?: FeatureStatusProvider;
  orchestration?: FeatureStatusProvider;
  contextBroker?: (ctx: unknown) => ContextBrokerStatusSource;
}

const FEATURE_ORDER = ["advisor", "router", "orchestration", "context-broker"] as const;

function errorStatus(feature: string, owner: string): FeatureStatusV1 {
  return createFeatureStatusV1({
    feature,
    owner,
    health: "error",
    enabled: false,
    mode: "unavailable",
    summary: "status adapter failed",
    diagnostics: { adapterError: true },
  });
}

function callStatus(feature: string, owner: string, provider: FeatureStatusProvider | undefined, ctx: unknown): FeatureStatusV1 {
  if (!provider) return createFeatureStatusV1({ feature, owner, health: "unavailable", enabled: false, mode: "unavailable", summary: "status adapter unavailable" });
  try {
    const status = provider(ctx);
    validateFeatureStatusV1(status);
    if (status.feature !== feature || status.owner !== owner) throw new Error("status identity mismatch");
    return status;
  } catch {
    return errorStatus(feature, owner);
  }
}

/** Build an ordered, read-only status catalog. Providers never receive lifecycle/control capabilities. */
export function createHarmonizationStatusCatalog(ctx: unknown, sources: HarmonizationStatusSources = {}): HarmonizationStatusCatalogV1 {
  const contextStatus = (): FeatureStatusV1 => {
    let contextSource: ContextBrokerStatusSource = { enabled: false, registered: false };
    try {
      contextSource = sources.contextBroker?.(ctx) ?? contextSource;
    } catch {
      contextSource = { enabled: true, registered: false, error: true };
    }
    return contextBrokerFeatureStatus(contextSource);
  };
  const statuses = [
    callStatus("advisor", "advisor", sources.advisor ?? (() => advisorFeatureStatus()), ctx),
    callStatus("router", "router", sources.router ?? ((value) => routerFeatureStatus(value)), ctx),
    callStatus("orchestration", "orchestration", sources.orchestration ?? ((value) => orchestrationFeatureStatus(value)), ctx),
    callStatus("context-broker", "context-broker", contextStatus, ctx),
  ];
  return { schema: HARMONIZATION_STATUS_CATALOG_SCHEMA, features: statuses };
}

/** Stable, privacy-checked representation for local reports and passive evidence. */
export function serializeHarmonizationStatusCatalog(catalog: HarmonizationStatusCatalogV1): string {
  if (catalog.schema !== HARMONIZATION_STATUS_CATALOG_SCHEMA) throw new Error("catalog.schema: invalid schema");
  if (!Array.isArray(catalog.features) || catalog.features.length !== FEATURE_ORDER.length) throw new Error("catalog.features: invalid feature count");
  catalog.features.forEach((status, index) => {
    validateFeatureStatusV1(status);
    if (status.feature !== FEATURE_ORDER[index]) throw new Error("catalog.features: non-canonical order");
  });
  return JSON.stringify({ schema: catalog.schema, features: catalog.features.map((status) => JSON.parse(serializeFeatureStatusV1(status))) });
}

export { FEATURE_ORDER };
