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
  const knownBackend = source.backend === "memory" || source.backend === "memory(degraded)" || source.backend === "sqlite" || source.backend === "jsonl"
    ? source.backend
    : source.backend === undefined ? (source.durable === false ? "memory" : undefined) : undefined;
  const backendInvalid = source.backend !== undefined && knownBackend === undefined;
  const degraded = knownBackend === "memory(degraded)";
  const health = !source.enabled ? "disabled" : source.error || backendInvalid ? "error" : !source.registered ? "unavailable" : degraded ? "degraded" : "ready";
  const mode = source.registered && knownBackend ? knownBackend : "unavailable";
  return createFeatureStatusV1({
    feature: "context-broker",
    owner: "context-broker",
    health,
    enabled: source.enabled,
    mode,
    summary: !source.enabled ? "context broker is disabled" : source.error || backendInvalid ? "context broker registration failed" : degraded ? "context broker is degraded" : source.registered ? "context broker is available" : "context broker is unavailable",
    diagnostics: {
      registered: source.registered,
      durable: source.durable ?? null,
      backend: knownBackend ?? null,
    },
  });
}

export function serializeContextBrokerFeatureStatus(source: ContextBrokerStatusSource): string {
  return serializeFeatureStatusV1(contextBrokerFeatureStatus(source));
}
