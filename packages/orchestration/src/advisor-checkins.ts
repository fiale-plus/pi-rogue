import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type AdvisorConfig = Record<string, unknown> & { checkins?: "mid-hour" | "off"; checkinStartedAt?: number };
type AdvisorState = Record<string, unknown> & {
  turns?: number;
  lastTask?: string;
  notes?: unknown[];
  files?: unknown[];
  errors?: unknown[];
  advisorCalls?: number;
  cacheHits?: number;
  followUp?: string;
  router?: Record<string, unknown>;
  checkin?: Record<string, unknown>;
  reviewControl?: {
    status?: "idle" | "needed" | "running" | "applied" | "consumed";
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

function readJson<T>(file: string): T {
  if (!existsSync(file)) return {} as T;
  try {
    return JSON.parse(readFileSync(file, "utf8") || "{}") as T;
  } catch {
    return {} as T;
  }
}

export function setAdvisorCheckinsEnabled(enabled: boolean, configPath = ADVISOR_CONFIG_PATH): AdvisorConfig {
  const current = readJson<AdvisorConfig>(configPath);
  const next: AdvisorConfig = {
    ...current,
    checkins: enabled ? "mid-hour" : "off",
    checkinStartedAt: enabled ? Date.now() : undefined,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function resetAdvisorSessionContext(
  configPath = ADVISOR_CONFIG_PATH,
  statePath = ADVISOR_STATE_PATH,
): { config: AdvisorConfig; state: AdvisorState } {
  const currentConfig = readJson<AdvisorConfig>(configPath);
  const nextConfig: AdvisorConfig = {
    ...currentConfig,
    checkinStartedAt: currentConfig.checkins === "mid-hour" ? Date.now() : undefined,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  const currentState = readJson<AdvisorState>(statePath);
  const nextState: AdvisorState = {
    ...currentState,
    turns: 0,
    lastTask: "",
    notes: [],
    files: [],
    errors: [],
    followUp: "",
    reviewControl: {
      status: "idle",
      pending: false,
      consumed: true,
      running: false,
    },
    router: {},
    checkin: { queued: false },
  };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");

  return { config: nextConfig, state: nextState };
}
