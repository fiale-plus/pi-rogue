import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { sessionKey, sessionScopedDir } from "@fiale-plus/pi-core";

type AdvisorConfig = Record<string, unknown> & { checkins?: "mid-hour" | "off"; checkinStartedAt?: number };
type CheckinDemandSource = "goal" | "loop";
type CheckinDemandRegistry = {
  version: 1;
  sessions: Record<string, { goal?: true; loop?: true; updatedAt: string }>;
};
type AdvisorState = Record<string, unknown> & {
  turns?: number;
  lastTask?: string;
  notes?: unknown[];
  files?: unknown[];
  errors?: unknown[];
  advisorCalls?: number;
  cacheHits?: number;
  followUp?: string;
  followUpTask?: string;
  reviewSignals?: unknown[];
  reviewSignalsTask?: string;
  router?: Record<string, unknown>;
  checkin?: Record<string, unknown>;
  reviewControl?: {
    status?: "idle" | "needed" | "running" | "consumed";
    pending?: boolean;
    consumed?: boolean;
    running?: boolean;
    lastDecision?: string;
    lastMaterialSignature?: string;
    lastReason?: string;
    lastTrigger?: string;
    lastAppliedAt?: string;
  };
};

const ADVISOR_DIR = join(homedir(), ".pi", "agent", "pi-rogue", "advisor");
const ADVISOR_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-rogue", "advisor", "config.json");
const ADVISOR_STATE_PATH = join(ADVISOR_DIR, "state.json");
const CHECKIN_DEMAND_PATH = join(ADVISOR_DIR, "checkin-demand.json");
const ORCHESTRATION_SESSIONS_DIR = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration");

/**
 * Demand writes are heartbeats. A lease spans at least two check-in cadences,
 * but is capped so a crashed owner without resumable orchestration state cannot
 * keep check-ins on indefinitely.
 */
const MIN_DEMAND_LEASE_MS = 30 * 60_000;
const MAX_DEMAND_LEASE_MS = 4 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function advisorSessionStatePath(ctx: any): string {
  return join(sessionScopedDir(join(ADVISOR_DIR, "sessions"), ctx), "state.json");
}

function readJson<T>(file: string): T {
  if (!existsSync(file)) return {} as T;
  try {
    return JSON.parse(readFileSync(file, "utf8") || "{}") as T;
  } catch {
    return {} as T;
  }
}

function cleanAdvisorConfig(config: AdvisorConfig): AdvisorConfig {
  const cleaned = { ...config };
  delete cleaned.checkinIntervalTurns;
  delete cleaned.advisorAutoRunCooldownUntilTurn;
  return cleaned;
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const staging = mkdtempSync(join(dirname(file), ".checkin-write-"));
  const temp = join(staging, "value.json");
  try {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temp, file);
    } catch {
      // Windows cannot reliably rename over an existing destination.
      writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function withDemandLock<T>(demandPath: string, fn: () => T): T {
  const lock = `${demandPath}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error: any) {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Another writer may have released the lock.
      }
      if (Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function demandRegistry(path: string): CheckinDemandRegistry {
  if (!existsSync(path)) return { version: 1, sessions: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid advisor check-in demand registry: ${path}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid advisor check-in demand registry: ${path}`);
  }
  const record = raw as Partial<CheckinDemandRegistry>;
  if (record.version !== 1 || !record.sessions || typeof record.sessions !== "object" || Array.isArray(record.sessions)) {
    throw new Error(`Invalid advisor check-in demand registry: ${path}`);
  }
  const sessions: CheckinDemandRegistry["sessions"] = {};
  for (const [key, value] of Object.entries(record.sessions)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid advisor check-in demand registry entry: ${key}`);
    }
    const entry = value as { goal?: unknown; loop?: unknown; updatedAt?: unknown };
    if ((entry.goal !== undefined && entry.goal !== true) || (entry.loop !== undefined && entry.loop !== true)) {
      throw new Error(`Invalid advisor check-in demand registry entry: ${key}`);
    }
    if (entry.goal !== true && entry.loop !== true) {
      throw new Error(`Invalid advisor check-in demand registry entry: ${key}`);
    }
    sessions[key] = {
      ...(entry.goal === true ? { goal: true as const } : {}),
      ...(entry.loop === true ? { loop: true as const } : {}),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
    };
  }
  return { version: 1, sessions };
}

function demandLeaseMs(configPath: string): number {
  const interval = Number(readJson<Record<string, unknown>>(configPath).checkinIntervalMinutes);
  const cadenceMs = Number.isFinite(interval) && interval > 0 ? interval * 60_000 : MIN_DEMAND_LEASE_MS;
  return Math.min(MAX_DEMAND_LEASE_MS, Math.max(MIN_DEMAND_LEASE_MS, cadenceMs * 2));
}

function isSessionPathInside(root: string, key: string): boolean {
  if (!key || key.includes("\0")) return false;
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, key);
  const rel = relative(resolvedRoot, candidate);
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function resumableDemandSources(key: string, orchestrationSessionsDir: string): { goal: boolean; loop: boolean } {
  if (!isSessionPathInside(orchestrationSessionsDir, key)) return { goal: false, loop: false };
  const sessionDir = join(orchestrationSessionsDir, key);
  let goal = false;
  let loop = false;
  try {
    goal = readFileSync(join(sessionDir, "goal.md"), "utf8").trim().length > 0;
  } catch {
    // A missing or unreadable session file cannot prove resumable demand.
  }
  try {
    const raw = JSON.parse(readFileSync(join(sessionDir, "loop.json"), "utf8")) as Record<string, unknown>;
    loop = raw.enabled === true && typeof raw.instruction === "string" && raw.instruction.trim().length > 0;
  } catch {
    // A malformed loop state cannot prove resumable demand.
  }
  return { goal, loop };
}

/** Reconcile stale heartbeats while retaining demand backed by resumable session state. Must run under withDemandLock. */
function reconcileDemandRegistry(
  registry: CheckinDemandRegistry,
  configPath: string,
  orchestrationSessionsDir: string,
  now = Date.now(),
): boolean {
  let changed = false;
  const leaseMs = demandLeaseMs(configPath);
  for (const [key, entry] of Object.entries(registry.sessions)) {
    const resumable = resumableDemandSources(key, orchestrationSessionsDir);
    const updatedAtMs = Date.parse(entry.updatedAt);
    const futureBy = Number.isFinite(updatedAtMs) ? updatedAtMs - now : Number.POSITIVE_INFINITY;
    // A small future skew is treated as "now"; a large future date is never allowed to extend a lease.
    const validLease = Number.isFinite(updatedAtMs)
      && futureBy <= MAX_CLOCK_SKEW_MS
      && now - Math.min(updatedAtMs, now) <= leaseMs;
    const next = {
      ...(entry.goal === true && (resumable.goal || validLease) ? { goal: true as const } : {}),
      ...(entry.loop === true && (resumable.loop || validLease) ? { loop: true as const } : {}),
      updatedAt: entry.updatedAt,
    };
    if (resumable.goal || resumable.loop) {
      // Durable active state is an explicit proof that this owner can resume, not an age-only exemption.
      next.updatedAt = new Date(now).toISOString();
    } else if (Number.isFinite(updatedAtMs) && updatedAtMs > now) {
      next.updatedAt = new Date(now).toISOString();
    }
    if (next.goal === true || next.loop === true) {
      if (next.goal !== entry.goal || next.loop !== entry.loop || next.updatedAt !== entry.updatedAt) {
        registry.sessions[key] = next;
        changed = true;
      }
    } else {
      delete registry.sessions[key];
      changed = true;
    }
  }
  return changed;
}

export type AdvisorCheckinDemandStatus = { enabled: boolean; owners: string[] };

function ownerDescription(key: string, entry: CheckinDemandRegistry["sessions"][string]): string {
  const label = key.replace(/^v2-/, "").replace(/-[a-f0-9]{16}$/i, "");
  const sources = [entry.goal ? "goal" : "", entry.loop ? "loop" : ""].filter(Boolean).join("+");
  return `${label} (${sources})`;
}

export function advisorCheckinDemandStatus(
  configPath = ADVISOR_CONFIG_PATH,
  demandPath = configPath === ADVISOR_CONFIG_PATH ? CHECKIN_DEMAND_PATH : join(dirname(configPath), "checkin-demand.json"),
  orchestrationSessionsDir = ORCHESTRATION_SESSIONS_DIR,
): AdvisorCheckinDemandStatus {
  return withDemandLock(demandPath, () => {
    const registry = demandRegistry(demandPath);
    if (reconcileDemandRegistry(registry, configPath, orchestrationSessionsDir)) atomicWriteJson(demandPath, registry);
    const owners = Object.entries(registry.sessions).map(([key, entry]) => ownerDescription(key, entry));
    applyAggregateConfig(owners.length > 0, configPath);
    return { enabled: owners.length > 0, owners };
  });
}

function applyAggregateConfig(enabled: boolean, configPath: string): AdvisorConfig {
  const current = cleanAdvisorConfig(readJson<AdvisorConfig>(configPath));
  const next: AdvisorConfig = {
    ...current,
    checkins: enabled ? "mid-hour" : "off",
    checkinStartedAt: enabled
      ? (current.checkins === "mid-hour" && Number.isFinite(current.checkinStartedAt) ? current.checkinStartedAt : Date.now())
      : undefined,
  };
  atomicWriteJson(configPath, next);
  return next;
}

/** Legacy direct global toggle retained for compatibility. New orchestration code uses per-session demand. */
export function setAdvisorCheckinsEnabled(enabled: boolean, configPath = ADVISOR_CONFIG_PATH): AdvisorConfig {
  return applyAggregateConfig(enabled, configPath);
}

export function setAdvisorCheckinDemand(
  ctx: any,
  source: CheckinDemandSource,
  enabled: boolean,
  configPath = ADVISOR_CONFIG_PATH,
  demandPath = configPath === ADVISOR_CONFIG_PATH ? CHECKIN_DEMAND_PATH : join(dirname(configPath), "checkin-demand.json"),
  orchestrationSessionsDir = ORCHESTRATION_SESSIONS_DIR,
): AdvisorConfig {
  return withDemandLock(demandPath, () => {
    const registry = demandRegistry(demandPath);
    const key = sessionKey(ctx);
    const current = registry.sessions[key] ?? { updatedAt: new Date().toISOString() };
    const next = { ...current, [source]: enabled ? true : undefined, updatedAt: new Date().toISOString() };
    if (next.goal === true || next.loop === true) registry.sessions[key] = next;
    else delete registry.sessions[key];
    // Reconcile after recording this writer's heartbeat so creating state just after claiming demand is safe.
    reconcileDemandRegistry(registry, configPath, orchestrationSessionsDir);
    atomicWriteJson(demandPath, registry);
    return applyAggregateConfig(Object.keys(registry.sessions).length > 0, configPath);
  });
}


export function resetAdvisorSessionContext(
  ctxOrConfigPath?: any,
  configPathOrStatePath = ADVISOR_STATE_PATH,
  explicitStatePath?: string,
): { config: AdvisorConfig; state: AdvisorState } {
  const legacyPaths = typeof ctxOrConfigPath === "string";
  const configPath = legacyPaths ? ctxOrConfigPath : ADVISOR_CONFIG_PATH;
  const statePath = legacyPaths
    ? configPathOrStatePath
    : explicitStatePath || (ctxOrConfigPath ? advisorSessionStatePath(ctxOrConfigPath) : ADVISOR_STATE_PATH);
  const currentConfig = cleanAdvisorConfig(readJson<AdvisorConfig>(configPath));
  const nextConfig: AdvisorConfig = {
    ...currentConfig,
    checkinStartedAt: legacyPaths
      ? (currentConfig.checkins === "mid-hour" ? Date.now() : undefined)
      : currentConfig.checkinStartedAt,
  };
  if (legacyPaths) atomicWriteJson(configPath, nextConfig);

  const currentState = readJson<AdvisorState>(statePath);
  const nextState: AdvisorState = {
    ...currentState,
    turns: 0,
    lastTask: "",
    notes: [],
    files: [],
    errors: [],
    followUp: "",
    followUpTask: undefined,
    reviewSignals: [],
    reviewSignalsTask: undefined,
    reviewControl: {
      status: "idle",
      pending: false,
      consumed: true,
      running: false,
    },
    router: {},
    checkin: { queued: false },
  };
  atomicWriteJson(statePath, nextState);

  return { config: nextConfig, state: nextState };
}
