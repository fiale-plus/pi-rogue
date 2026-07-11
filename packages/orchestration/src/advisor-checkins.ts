import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
): AdvisorConfig {
  return withDemandLock(demandPath, () => {
    const registry = demandRegistry(demandPath);
    const key = sessionKey(ctx);
    const current = registry.sessions[key] ?? { updatedAt: new Date().toISOString() };
    const next = { ...current, [source]: enabled ? true : undefined, updatedAt: new Date().toISOString() };
    if (next.goal === true || next.loop === true) registry.sessions[key] = next;
    else delete registry.sessions[key];
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
