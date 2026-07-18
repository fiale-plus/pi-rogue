export const FEATURE_STATUS_V1 = "FeatureStatusV1" as const;

export type FeatureStatusHealth = "unavailable" | "disabled" | "unconfigured" | "idle" | "ready" | "degraded" | "error";

export interface FeatureStatusV1 {
  schema: typeof FEATURE_STATUS_V1;
  feature: string;
  owner: string;
  health: FeatureStatusHealth;
  enabled: boolean;
  mode?: string;
  summary?: string;
  /** Feature-owned, additive diagnostics. Consumers must ignore unknown fields. */
  diagnostics?: Record<string, unknown>;
}

export type FeatureStatusV1Input = Omit<FeatureStatusV1, "schema">;

export function createFeatureStatusV1(input: FeatureStatusV1Input): FeatureStatusV1 {
  return { ...input, schema: FEATURE_STATUS_V1 };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

/** Stable JSON representation for logs, snapshots, and passive status catalogs. */
export function serializeFeatureStatusV1(status: FeatureStatusV1): string {
  return JSON.stringify(canonicalize(status));
}
