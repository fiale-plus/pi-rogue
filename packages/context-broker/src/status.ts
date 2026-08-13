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
  const candidate = source && typeof source === "object" && !Array.isArray(source) ? source : undefined;
  const sourceShapeValid = candidate !== undefined
    && typeof candidate.enabled === "boolean"
    && typeof candidate.registered === "boolean"
    && (candidate.durable === undefined || typeof candidate.durable === "boolean")
    && (candidate.error === undefined || typeof candidate.error === "boolean");
  const enabled = sourceShapeValid && candidate.enabled;
  const registered = sourceShapeValid && candidate.registered;
  const durable = sourceShapeValid && typeof candidate.durable === "boolean" ? candidate.durable : undefined;
  const knownBackend = sourceShapeValid && (candidate.backend === "memory" || candidate.backend === "memory(degraded)" || candidate.backend === "sqlite" || candidate.backend === "jsonl")
    ? candidate.backend
    : sourceShapeValid && candidate.backend === undefined ? (durable === false ? "memory" : undefined) : undefined;
  const backendInvalid = (candidate?.backend !== undefined && knownBackend === undefined) || (registered && knownBackend === undefined);
  const degraded = knownBackend === "memory(degraded)";
  const health = !sourceShapeValid || candidate?.error || backendInvalid ? "error" : !enabled ? "disabled" : !registered ? "unavailable" : degraded ? "degraded" : "ready";
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
