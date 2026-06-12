import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RouterMode = "observe";
export type RouterPrintMode = "all" | "mismatch_only" | "off";

export interface RouterProfile {
  worker: string;
  smart: string;
  teacher: string;
  reviewer: string;
}

export interface RouterConfig {
  enabled: boolean;
  mode: RouterMode;
  print: RouterPrintMode;
  activeProfile: string;
  profileOrder: string[];
  profiles: Record<string, RouterProfile>;
}

export interface RouterState {
  lastObservedCheckpointId?: string;
  lastDecisionAction?: string;
  lastSummary?: string;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enabled: false,
  mode: "observe",
  print: "mismatch_only",
  activeProfile: "all-smart",
  profileOrder: ["all-smart", "spark-smart", "local-smart"],
  profiles: {
    "all-smart": {
      worker: "openai-codex/gpt-5.5",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
    },
    "spark-smart": {
      worker: "openai-codex/gpt-5.3-codex-spark",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
    },
    "local-smart": {
      worker: "qwen3.6-35b-a3b-128k",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
    },
  },
};

function cwdFromCtx(ctx: any): string {
  return resolve(String(ctx?.cwd ?? process.cwd()));
}

export function routerDir(ctx: any): string {
  return join(cwdFromCtx(ctx), ".pi", "router");
}

export function routerConfigPath(ctx: any): string {
  return join(routerDir(ctx), "config.json");
}

export function routerStatePath(ctx: any): string {
  return join(routerDir(ctx), "state.json");
}

export function routerEventsPath(ctx: any): string {
  return join(routerDir(ctx), "events.jsonl");
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function normalizeRouterConfig(raw: Partial<RouterConfig> | null | undefined): RouterConfig {
  const mergedProfiles = { ...DEFAULT_ROUTER_CONFIG.profiles, ...(raw?.profiles ?? {}) };
  const profileOrder = Array.isArray(raw?.profileOrder) && raw.profileOrder.length > 0
    ? raw.profileOrder.filter((name) => typeof name === "string" && mergedProfiles[name])
    : DEFAULT_ROUTER_CONFIG.profileOrder;
  const activeProfile = raw?.activeProfile && mergedProfiles[raw.activeProfile]
    ? raw.activeProfile
    : profileOrder[0] ?? DEFAULT_ROUTER_CONFIG.activeProfile;
  const print = raw?.print === "all" || raw?.print === "off" || raw?.print === "mismatch_only" ? raw.print : DEFAULT_ROUTER_CONFIG.print;
  return {
    enabled: Boolean(raw?.enabled ?? DEFAULT_ROUTER_CONFIG.enabled),
    mode: "observe",
    print,
    activeProfile,
    profileOrder,
    profiles: mergedProfiles,
  };
}

export function loadRouterConfig(ctx: any): RouterConfig {
  return normalizeRouterConfig(readJson<Partial<RouterConfig>>(routerConfigPath(ctx), {}));
}

export function saveRouterConfig(ctx: any, config: RouterConfig): void {
  const path = routerConfigPath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeRouterConfig(config), null, 2)}\n`);
}

export function ensureRouterConfig(ctx: any): RouterConfig {
  const path = routerConfigPath(ctx);
  const config = loadRouterConfig(ctx);
  if (!existsSync(path)) saveRouterConfig(ctx, config);
  return config;
}

export function loadRouterState(ctx: any): RouterState {
  return readJson<RouterState>(routerStatePath(ctx), {});
}

export function saveRouterState(ctx: any, state: RouterState): void {
  const path = routerStatePath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function activeProfile(config: RouterConfig): RouterProfile {
  return config.profiles[config.activeProfile] ?? config.profiles[config.profileOrder[0]] ?? DEFAULT_ROUTER_CONFIG.profiles[DEFAULT_ROUTER_CONFIG.activeProfile];
}

export function cycleRouterProfile(config: RouterConfig, direction: 1 | -1 = 1): RouterConfig {
  const order = config.profileOrder.filter((name) => config.profiles[name]);
  if (order.length === 0) return normalizeRouterConfig(config);
  const currentIndex = Math.max(0, order.indexOf(config.activeProfile));
  const nextIndex = (currentIndex + direction + order.length) % order.length;
  return { ...config, activeProfile: order[nextIndex] };
}

export function setRouterProfile(config: RouterConfig, name: string): RouterConfig | null {
  if (!config.profiles[name]) return null;
  return { ...config, activeProfile: name, profileOrder: config.profileOrder.includes(name) ? config.profileOrder : [...config.profileOrder, name] };
}

export function formatProfile(name: string, profile: RouterProfile): string {
  return `${name}: worker=${profile.worker} smart=${profile.smart} teacher=${profile.teacher} reviewer=${profile.reviewer}`;
}
