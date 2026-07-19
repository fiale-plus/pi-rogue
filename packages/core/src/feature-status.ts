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

const HEALTH_VALUES = new Set<FeatureStatusHealth>(["unavailable", "disabled", "unconfigured", "idle", "ready", "degraded", "error"]);
const PROHIBITED_KEY = /prompt|transcript|payload|path|secret|credential|password|email|raw|content|filesystem|user/i;
const MAX_DIAGNOSTIC_DEPTH = 5;
const MAX_DIAGNOSTIC_ENTRIES = 64;
const MAX_DIAGNOSTIC_ITEMS = 32;

export function createFeatureStatusV1(input: FeatureStatusV1Input): FeatureStatusV1 {
  const status = { ...input, schema: FEATURE_STATUS_V1 } as FeatureStatusV1;
  validateFeatureStatusV1(status);
  return status;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeStatusText(value: string): boolean {
  return value.length <= 160 && /^[A-Za-z0-9 _.,:;()=\-]+$/.test(value);
}

function validateDiagnosticValue(value: unknown, path: string, depth = 0, active = new WeakSet<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (!isSafeStatusText(value)) throw new Error(`${path}: unsafe or unbounded text`);
    return;
  }
  if (depth > MAX_DIAGNOSTIC_DEPTH) throw new Error(`${path}: diagnostic depth exceeds limit`);
  if (!value || typeof value !== "object") throw new Error(`${path}: unsupported diagnostic value`);
  if (active.has(value)) throw new Error(`${path}: cyclic diagnostics are not allowed`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_DIAGNOSTIC_ITEMS) throw new Error(`${path}: diagnostic array exceeds limit`);
      value.forEach((item, index) => validateDiagnosticValue(item, `${path}[${index}]`, depth + 1, active));
      return;
    }
    if (!isPlainRecord(value)) throw new Error(`${path}: expected a JSON object`);
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_DIAGNOSTIC_ENTRIES) throw new Error(`${path}: diagnostic object exceeds limit`);
    for (const key of keys) {
      if (typeof key !== "string") throw new Error(`${path}: symbol field is not allowed`);
      if (PROHIBITED_KEY.test(key)) throw new Error(`${path}.${key}: prohibited field`);
      validateDiagnosticValue(value[key], `${path}.${key}`, depth + 1, active);
    }
  } finally {
    active.delete(value);
  }
}

/** Validate the public, passive status shape before it crosses a package boundary. */
export function validateFeatureStatusV1(status: FeatureStatusV1): void {
  if (!isPlainRecord(status)) throw new Error("status: expected a plain object");
  const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(status, key);
  for (const key of ["schema", "feature", "owner", "health", "enabled"]) {
    if (!hasOwn(key)) throw new Error(`status.${key}: required field missing`);
  }
  if (status.schema !== FEATURE_STATUS_V1) throw new Error("status.schema: invalid schema");
  if (typeof status.feature !== "string" || !/^[a-z0-9-]+$/.test(status.feature)) throw new Error("status.feature: invalid feature");
  if (typeof status.owner !== "string" || !/^[a-z0-9-]+$/.test(status.owner)) throw new Error("status.owner: invalid owner");
  if (!HEALTH_VALUES.has(status.health)) throw new Error("status.health: invalid health");
  if (typeof status.enabled !== "boolean") throw new Error("status.enabled: expected boolean");
  if (status.mode !== undefined && (typeof status.mode !== "string" || !/^[a-z0-9][a-z0-9_.:()\-]{0,63}$/.test(status.mode))) throw new Error("status.mode: unsafe or invalid mode");
  if (status.summary !== undefined && (typeof status.summary !== "string" || !isSafeStatusText(status.summary))) throw new Error("status.summary: unsafe or unbounded text");
  if (status.diagnostics !== undefined) {
    if (!isPlainRecord(status.diagnostics)) throw new Error("status.diagnostics: expected a plain object");
    validateDiagnosticValue(status.diagnostics, "status.diagnostics");
  }
  for (const key of Reflect.ownKeys(status)) {
    if (typeof key !== "string") throw new Error("status: symbol field is not allowed");
    if (!["schema", "feature", "owner", "health", "enabled", "mode", "summary", "diagnostics"].includes(key)) {
      throw new Error(`status.${key}: unknown field`);
    }
  }
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
  validateFeatureStatusV1(status);
  return JSON.stringify(canonicalize(status));
}
