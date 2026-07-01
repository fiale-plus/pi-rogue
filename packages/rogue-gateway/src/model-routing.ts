import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import type {
  GatewaySubstrate,
  SubstrateChatRequest,
  SubstrateChatResult,
  SubstrateCostQuote,
  SubstrateModel,
  SubstrateUsage,
} from "./substrate.js";
import { PortkeyCompatibleSubstrate } from "./substrate-portkey.js";

export interface PiRogueRouterProfileConfig {
  [role: string]: string | undefined;
}

export interface PiRogueRouterConfig {
  enabled?: boolean;
  mode?: string;
  activeProfile?: string;
  profileOrder?: string[];
  profiles: Record<string, PiRogueRouterProfileConfig>;
}

export interface PiRogueRootConfig {
  router?: {
    enabled?: boolean;
    activeProfile?: string;
    config?: string;
  };
  storage?: {
    root?: string;
  };
}

export interface ModelRoutingSelection {
  profile: string;
  role: string;
  requestedModel: string;
  upstreamModel: string;
  source: "profile-role" | "profile-fallback" | "requested-model";
}

export interface RoutedGatewayOptions {
  profile?: string;
  role?: string;
}

export interface RoutedGatewayFactoryOptions extends RoutedGatewayOptions {
  routerConfig?: PiRogueRouterConfig;
  routerConfigPath?: string;
}

export const PI_DEDICATED_MODEL_ALIAS = "pi-dedicated" as const;
export const DEFAULT_PI_ROGUE_ROOT = resolve(homedir(), ".pi", "agent", "pi-rogue");
export const DEFAULT_PI_ROGUE_CONFIG_PATH = join(DEFAULT_PI_ROGUE_ROOT, "config.json");

function resolvePiRogueConfigPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_ROGUE_CONFIG_PATH?.trim() || DEFAULT_PI_ROGUE_CONFIG_PATH;
}

function resolvePiRogueRouterConfigPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_ROGUE_ROUTER_CONFIG_PATH?.trim()
    || join(dirname(resolvePiRogueConfigPathFromEnv(env)), "router", "config.json");
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

function resolvePath(basePath: string, maybeRelativePath: string): string {
  if (isAbsolute(maybeRelativePath)) return maybeRelativePath;
  return resolve(dirname(basePath), maybeRelativePath);
}

export async function loadPiRogueRootConfig(configPath = resolvePiRogueConfigPathFromEnv()): Promise<PiRogueRootConfig> {
  return await readJson<PiRogueRootConfig>(configPath);
}

export async function loadPiRogueRouterConfig(configPath?: string): Promise<PiRogueRouterConfig> {
  const candidatePath = configPath ?? resolvePiRogueRouterConfigPathFromEnv();
  const directConfig = await readJson<Partial<PiRogueRouterConfig> & PiRogueRootConfig>(candidatePath);

  if (directConfig && typeof directConfig === "object" && "profiles" in directConfig) {
    return directConfig as PiRogueRouterConfig;
  }

  const root = directConfig as PiRogueRootConfig;
  const routerPath = root.router?.config
    ? resolvePath(candidatePath, root.router.config)
    : resolvePiRogueRouterConfigPathFromEnv({ ...process.env, PI_ROGUE_CONFIG_PATH: candidatePath });

  const routerConfig = await readJson<PiRogueRouterConfig>(routerPath);
  if (root.router?.activeProfile && !routerConfig.activeProfile) {
    routerConfig.activeProfile = root.router.activeProfile;
  }
  return routerConfig;
}

export function resolveRouterModelTarget(
  routerConfig: PiRogueRouterConfig,
  options: {
    profile?: string;
    role?: string;
    requestedModel?: string;
  } = {},
): ModelRoutingSelection {
  const profile = options.profile ?? routerConfig.activeProfile ?? Object.keys(routerConfig.profiles)[0] ?? "";
  const role = options.role ?? "smart";
  const profileConfig = routerConfig.profiles[profile] ?? {};
  const requestedModel = options.requestedModel ?? "";

  const roleTarget = profileConfig[role];
  if (typeof roleTarget === "string" && roleTarget.trim().length > 0) {
    return {
      profile,
      role,
      requestedModel,
      upstreamModel: roleTarget,
      source: "profile-role",
    };
  }

  const fallbackRoles = ["smart", "worker", "reviewer", "teacher", "explore", "debug_diagnose", "verify", "review"];
  for (const fallbackRole of fallbackRoles) {
    const candidate = profileConfig[fallbackRole];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return {
        profile,
        role,
        requestedModel,
        upstreamModel: candidate,
        source: "profile-fallback",
      };
    }
  }

  if (requestedModel.trim().length > 0) {
    return {
      profile,
      role,
      requestedModel,
      upstreamModel: requestedModel,
      source: "requested-model",
    };
  }

  throw new Error(`No model target configured for profile ${profile}`);
}

class RoutedGatewaySubstrate implements GatewaySubstrate {
  constructor(
    public readonly id: string,
    private readonly upstream: GatewaySubstrate,
    private readonly routerConfig: PiRogueRouterConfig,
    private readonly options: RoutedGatewayOptions = {},
  ) {}

  async listModels(): Promise<SubstrateModel[]> {
    return await this.upstream.listModels();
  }

  async callChat(req: SubstrateChatRequest): Promise<SubstrateChatResult> {
    const target = resolveRouterModelTarget(this.routerConfig, {
      profile: this.options.profile,
      role: this.options.role,
      requestedModel: req.model,
    });

    return await this.upstream.callChat({
      ...req,
      model: target.upstreamModel,
    });
  }

  async estimateCost(req: {
    model: string;
    inputTokensApprox: number;
    outputTokensApprox: number;
    cachedInputTokensApprox?: number;
  }): Promise<SubstrateCostQuote> {
    const target = resolveRouterModelTarget(this.routerConfig, {
      profile: this.options.profile,
      role: this.options.role,
      requestedModel: req.model,
    });

    const upstreamEstimate = this.upstream.estimateCost;
    if (!upstreamEstimate) {
      return {
        inputCostUsdPerMTok: 0,
        outputCostUsdPerMTok: 0,
        cachedInputCostUsdPerMTok: 0,
        currency: "USD",
      };
    }

    return await upstreamEstimate.call(this.upstream, {
      ...req,
      model: target.upstreamModel,
    });
  }

  async getUsage(runId: string): Promise<SubstrateUsage | null> {
    const upstreamUsage = this.upstream.getUsage;
    if (!upstreamUsage) return null;
    return await upstreamUsage.call(this.upstream, runId);
  }
}

export async function createRoutedGatewaySubstrate(
  upstream: GatewaySubstrate,
  options: RoutedGatewayFactoryOptions = {},
): Promise<GatewaySubstrate> {
  const routerConfig = options.routerConfig ?? (await loadPiRogueRouterConfig(options.routerConfigPath));
  return new RoutedGatewaySubstrate("substrate-routed", upstream, routerConfig, options);
}

export async function createRoutedPortkeyGatewaySubstrate(
  options: RoutedGatewayFactoryOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<GatewaySubstrate> {
  const upstream = PortkeyCompatibleSubstrate.fromEnv(options.env);
  return await createRoutedGatewaySubstrate(upstream, options);
}
