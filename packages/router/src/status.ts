import { existsSync, readFileSync } from "node:fs";
import type { FeatureStatusV1 } from "@fiale-plus/pi-core";
import { createFeatureStatusV1, serializeFeatureStatusV1 } from "@fiale-plus/pi-core";
import { DEFAULT_ROUTER_CONFIG, activeProfile, loadRouterConfig, loadRouterState, routerGlobalConfigPath, routerStatePath, type RouterConfig } from "./config.js";

type JsonRead = { present: boolean; valid: boolean; value?: unknown };

function readJson(path: string): JsonRead {
  if (!existsSync(path)) return { present: false, valid: true };
  try {
    return { present: true, valid: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { present: true, valid: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRouterStateShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const field of ["lastObservedCheckpointId", "lastDecisionAction", "lastSummary", "autoModelPendingTarget", "autoModelLastSwitchAt"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (value.autoModelPendingStreak !== undefined && typeof value.autoModelPendingStreak !== "number") return false;
  if (value.autoModelSwitchHistory !== undefined && (!Array.isArray(value.autoModelSwitchHistory) || value.autoModelSwitchHistory.some((item) => typeof item !== "string"))) return false;
  if (value.lastCheckpointReplayParse !== undefined) {
    const parse = value.lastCheckpointReplayParse;
    if (!isRecord(parse) || typeof parse.parsedEventCount !== "number" || (parse.source !== "full" && parse.source !== "replay" && parse.source !== "none")) return false;
  }
  return true;
}

function isRouterConfigShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.mode !== undefined && value.mode !== "observe" && value.mode !== "auto" && value.mode !== "auto_model") return false;
  if (value.print !== undefined && value.print !== "all" && value.print !== "mismatch_only" && value.print !== "off") return false;
  if (value.activeProfile !== undefined && typeof value.activeProfile !== "string") return false;
  if (value.profiles !== undefined && (!isRecord(value.profiles) || Object.values(value.profiles).some((profile) => {
    if (!isRecord(profile)) return true;
    return ["main", "worker", "smart", "teacher", "reviewer", "explore", "debug_diagnose", "review", "verify"]
      .some((field) => profile[field] !== undefined && typeof profile[field] !== "string");
  }))) return false;
  if (value.profileOrder !== undefined && (!Array.isArray(value.profileOrder) || value.profileOrder.some((name) => typeof name !== "string"))) return false;
  const autoModel = value.autoModel;
  if (autoModel !== undefined && (!isRecord(autoModel) || [
    "minConfidence", "downgradeConfidence", "requiredConsecutiveMismatches", "minCooldownSeconds", "maxSwitchesPerWindow", "switchWindowSeconds",
  ].some((field) => autoModel[field] !== undefined && typeof autoModel[field] !== "number"))) return false;
  return true;
}

/** Read-only Router status adapter. It never creates, migrates, or writes state. */
export function routerFeatureStatus(ctx: any): FeatureStatusV1 {
  const configPath = routerGlobalConfigPath();
  const configRead = readJson(configPath);
  const configShapeValid = !configRead.present || isRouterConfigShape(configRead.value);
  let config: RouterConfig = DEFAULT_ROUTER_CONFIG;
  let configValid = configRead.valid && configShapeValid;
  if (configValid) {
    try {
      config = loadRouterConfig(ctx);
    } catch {
      configValid = false;
    }
  }
  const statePath = routerStatePath(ctx);
  const stateRead = readJson(statePath);
  const stateShapeValid = !stateRead.present || isRouterStateShape(stateRead.value);
  const state = stateShapeValid ? loadRouterState(ctx) : {};
  const profile = activeProfile(config);

  const hasSessionIdentity = Boolean(ctx?.sessionManager?.getSessionFile?.() || ctx?.session?.id || process.env.PI_ROGUE_SESSION_ID);
  const health = !configRead.present
    ? "unconfigured"
    : !configValid || !stateRead.valid || !stateShapeValid
      ? "error"
      : !config.enabled
        ? "disabled"
        : !hasSessionIdentity
          ? "degraded"
          : stateRead.present && stateShapeValid && (state.lastObservedCheckpointId || state.lastDecisionAction)
            ? "ready"
            : "idle";

  return createFeatureStatusV1({
    feature: "router",
    owner: "router",
    health,
    enabled: config.enabled,
    mode: config.mode,
    summary: config.enabled ? "router is enabled" : "router is disabled",
    diagnostics: {
      configSource: configRead.present ? "global" : "built-in-defaults",
      configValid,
      statePresent: stateRead.present,
      stateValid: stateRead.valid && stateShapeValid,
      sessionScoped: hasSessionIdentity,
      print: config.print,
    },
  });
}

export function serializeRouterFeatureStatus(ctx: any): string {
  return serializeFeatureStatusV1(routerFeatureStatus(ctx));
}
