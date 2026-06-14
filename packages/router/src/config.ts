import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hashText } from "./hash.js";

export type RouterMode = "observe" | "auto_model";
export type RouterPrintMode = "all" | "mismatch_only" | "off";

export interface RouterProfile {
  main?: string;
  worker: string;
  smart: string;
  teacher: string;
  reviewer: string;
  explore?: string;
  debug_diagnose?: string;
  review?: string;
  verify?: string;
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
      explore: "openai-codex/gpt-5.5",
      debug_diagnose: "openai-codex/gpt-5.5",
      review: "openai-codex/gpt-5.5",
      verify: "openai-codex/gpt-5.5",
    },
    "spark-smart": {
      worker: "openai-codex/gpt-5.3-codex-spark",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
      explore: "openai-codex/gpt-5.3-codex-spark",
      debug_diagnose: "openai-codex/gpt-5.5",
      review: "openai-codex/gpt-5.5",
      verify: "openai-codex/gpt-5.3-codex-spark",
    },
    "local-smart": {
      worker: "qwen3.6-35b-a3b-128k",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
      explore: "qwen3.6-35b-a3b-128k",
      debug_diagnose: "openai-codex/gpt-5.5",
      review: "openai-codex/gpt-5.5",
      verify: "qwen3.6-35b-a3b-128k",
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

function sessionPathFromCtx(ctx: any): string | undefined {
  const value = ctx?.sessionManager?.getSessionFile?.();
  return value ? String(value) : undefined;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "session";
}

export function routerSessionKey(sessionPath: string): string {
  const resolved = resolve(sessionPath);
  const name = safeSegment(basename(resolved).replace(/\.jsonl$/i, ""));
  return `${name}-${hashText(resolved).slice(0, 8)}`;
}

export function routerSessionsDir(ctx: any): string {
  return join(routerDir(ctx), "sessions");
}

export function routerSessionDir(ctx: any, sessionPath = sessionPathFromCtx(ctx)): string {
  const key = sessionPath ? routerSessionKey(sessionPath) : "no-session";
  return join(routerSessionsDir(ctx), key);
}

export function routerStatePath(ctx: any, sessionPath = sessionPathFromCtx(ctx)): string {
  return join(routerSessionDir(ctx, sessionPath), "state.json");
}

export function routerEventsPath(ctx: any, sessionPath = sessionPathFromCtx(ctx)): string {
  return join(routerSessionDir(ctx, sessionPath), "events.jsonl");
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function normalizeRouterMode(value: unknown): RouterMode {
  return value === "auto_model" || value === "auto" ? "auto_model" : "observe";
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
    mode: normalizeRouterMode(raw?.mode),
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

export function loadRouterState(ctx: any, sessionPath?: string): RouterState {
  return readJson<RouterState>(routerStatePath(ctx, sessionPath), {});
}

export function saveRouterState(ctx: any, state: RouterState, sessionPath?: string): void {
  const path = routerStatePath(ctx, sessionPath);
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

export function setRouterMode(config: RouterConfig, mode: string): RouterConfig | null {
  if (mode === "observe") return { ...config, mode: "observe" };
  if (mode === "auto" || mode === "auto_model") return { ...config, mode: "auto_model" };
  return null;
}

export function formatProfile(name: string, profile: RouterProfile): string {
  const subagents = [`explore=${profile.explore ?? profile.worker}`, `debug=${profile.debug_diagnose ?? profile.smart}`, `review=${profile.review ?? profile.reviewer}`, `verify=${profile.verify ?? profile.worker}`].join(" ");
  return `${name}: worker=${profile.worker} smart=${profile.smart} teacher=${profile.teacher} reviewer=${profile.reviewer} ${subagents}`;
}
