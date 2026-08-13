import { createFeatureStatusV1, serializeFeatureStatusV1, type FeatureStatusV1 } from "@fiale-plus/pi-core";

export type ContextBrokerBackend = "memory" | "memory(degraded)" | "sqlite" | "jsonl";

export interface ContextBrokerStatusSource {
  enabled: boolean;
  registered: boolean;
  durable?: boolean;
  backend?: ContextBrokerBackend | string;
  error?: boolean;
}

/** Read-only Context Broker status adapter. It reports a supplied runtime marker and never touches storage. */
export function contextBrokerFeatureStatus(source: ContextBrokerStatusSource): FeatureStatusV1 {
  const sourceShapeValid = typeof source.enabled === "boolean"
    && typeof source.registered === "boolean"
    && (source.durable === undefined || typeof source.durable === "boolean")
    && (source.error === undefined || typeof source.error === "boolean");
  const enabled = sourceShapeValid && source.enabled;
  const registered = sourceShapeValid && source.registered;
  const durable = sourceShapeValid && typeof source.durable === "boolean" ? source.durable : undefined;
  const knownBackend = sourceShapeValid && (source.backend === "memory" || source.backend === "memory(degraded)" || source.backend === "sqlite" || source.backend === "jsonl")
    ? source.backend
    : sourceShapeValid && source.backend === undefined ? (durable === false ? "memory" : undefined) : undefined;
  const backendInvalid = (source.backend !== undefined && knownBackend === undefined) || (registered && knownBackend === undefined);
  const degraded = knownBackend === "memory(degraded)";
  const health = !sourceShapeValid || source.error || backendInvalid ? "error" : !enabled ? "disabled" : !registered ? "unavailable" : degraded ? "degraded" : "ready";
  const mode = registered && knownBackend ? knownBackend : "unavailable";
  return createFeatureStatusV1({
    feature: "context-broker",
    owner: "context-broker",
    health,
    enabled,
    mode,
    summary: !sourceShapeValid || source.error || backendInvalid ? "context broker registration failed" : !enabled ? "context broker is disabled" : degraded ? "context broker is degraded" : registered ? "context broker is available" : "context broker is unavailable",
    diagnostics: {
      registered,
      durable: durable ?? null,
      backend: knownBackend ?? null,
    },
  });
}

export function serializeContextBrokerFeatureStatus(source: ContextBrokerStatusSource): string {
  return serializeFeatureStatusV1(contextBrokerFeatureStatus(source));
}
