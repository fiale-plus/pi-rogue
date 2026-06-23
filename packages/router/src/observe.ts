import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendRouteEvent, buildRouteEvent } from "./ledger.js";
import { decideRoute } from "./decision.js";
import { checkpointWithDiffStats, streamCheckpointsFromSessionPath } from "./checkpoints.js";
import {
  activeProfile,
  loadRouterConfig,
  loadRouterState,
  routerConfigPath,
  routerDir,
  routerEventsPath,
  routerStatePath,
  saveRouterState,
  type RouterConfig,
  type RouterProfile,
  type RouterState,
} from "./config.js";
import type { RouteAction, RouteDecision, RouterCheckpoint } from "./types.js";

export interface RouterObserveSummary {
  checkpointId: string;
  action: RouteAction;
  role: keyof RouterProfile | "none" | "current";
  targetModel?: string;
  currentModel?: string;
  currentProvider?: string;
  match: boolean | null;
  confidence: number;
  reason: string;
  text: string;
}

export interface RouterModelApplySummary {
  applied: boolean;
  reason: string;
  fromModel?: string;
  toModel?: string;
  status?: "applied" | "policy_noop" | "blocked";
}

export interface AutoModelSwitchPlan {
  canApply: boolean;
  reason: string;
  statePatch: Partial<RouterState>;
}

function squish(text: unknown, max = 140): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

type ProfileRole = keyof RouterProfile;

const ROLE_FALLBACKS: Partial<Record<ProfileRole, ProfileRole>> = {
  explore: "worker",
  debug_diagnose: "smart",
  review: "reviewer",
  verify: "worker",
};

export function actionRole(action: RouteAction): RouterObserveSummary["role"] {
  switch (action) {
    case "continue_current": return "current";
    case "continue_local": return "worker";
    case "summarize_context": return "worker";
    case "run_verifier": return "verify";
    case "ask_micro_hint": return "smart";
    case "escalate_plan_critique": return "smart";
    case "escalate_debug_diagnosis": return "debug_diagnose";
    case "escalate_diff_review": return "review";
    case "delegate_full_step": return "smart";
    case "spawn_subagent": return "smart";
    case "merge_subagent_result": return "current";
    case "stop_and_ask_user": return "none";
  }
}

function roleFallback(role: ProfileRole): ProfileRole | undefined {
  return ROLE_FALLBACKS[role];
}

export function resolvedProfileTarget(role: ProfileRole, profile: RouterProfile): { targetModel?: string; fallbackRole?: ProfileRole } {
  const direct = profile[role];
  if (direct) return { targetModel: direct };
  const fallback = roleFallback(role);
  return fallback ? { targetModel: profile[fallback], fallbackRole: fallback } : {};
}

export function formatLiveRoleMap(profile: RouterProfile): string[] {
  const line = (label: string, role: ProfileRole): string => {
    const resolved = resolvedProfileTarget(role, profile);
    const fallback = resolved.fallbackRole ? ` (fallback: ${resolved.fallbackRole})` : "";
    return `${label}: ${role}=${resolved.targetModel ?? "unset"}${fallback}`;
  };
  return [
    line("continue/summarize", "worker"),
    line("verify", "verify"),
    line("smart hint/plan/delegate", "smart"),
    line("debug diagnosis", "debug_diagnose"),
    line("diff review", "review"),
  ];
}

function modelLeaf(model: string): string {
  return model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
}

export function modelsMatch(current: string | undefined, target: string | undefined, currentProvider?: string): boolean | null {
  if (!current || !target) return null;
  const c = current.toLowerCase();
  const t = target.toLowerCase();
  const provider = currentProvider?.toLowerCase();
  const currentHasProvider = c.includes("/");
  const targetHasProvider = t.includes("/");

  if (targetHasProvider) {
    const [targetProvider, ...targetModelParts] = t.split("/");
    const targetModel = targetModelParts.join("/");
    if (provider) {
      const currentModel = c.startsWith(`${provider}/`) ? c.slice(provider.length + 1) : c;
      if (provider === targetProvider) return currentModel === targetModel;
      return currentHasProvider ? c === t : false;
    }
    return c === t;
  }

  if (currentHasProvider) return false;
  return c === t || modelLeaf(c) === modelLeaf(t);
}

function targetForRole(role: RouterObserveSummary["role"], profile: RouterProfile, currentModel?: string): string | undefined {
  if (role === "current") return currentModel;
  if (role === "none") return undefined;
  return resolvedProfileTarget(role, profile).targetModel;
}

export function summarizeRouterDecision(checkpoint: RouterCheckpoint, decision: RouteDecision, config: RouterConfig): RouterObserveSummary {
  const profile = activeProfile(config);
  const role = actionRole(decision.action);
  const targetModel = targetForRole(role, profile, checkpoint.activeModel);
  const match = role === "none" ? null : modelsMatch(checkpoint.activeModel, targetModel, checkpoint.provider);
  const verdict = match === null ? "INFO" : match ? "MATCH" : "MISMATCH";
  const roleText = role === "none" ? "no-model" : role;
  const targetText = targetModel ? `${roleText}(${targetModel})` : roleText;
  const currentText = checkpoint.activeModel ? `current=${checkpoint.activeModel}` : "current=unknown";
  return {
    checkpointId: checkpoint.checkpointId,
    action: decision.action,
    role,
    targetModel,
    currentModel: checkpoint.activeModel,
    currentProvider: checkpoint.provider,
    match,
    confidence: decision.confidence,
    reason: decision.reason,
    text: `router: ${verdict} ${decision.action} → ${targetText} · ${currentText} · ${decision.confidence.toFixed(2)} · ${squish(decision.reason)}`,
  };
}

export async function latestCheckpointFromSession(sessionPath: string): Promise<RouterCheckpoint | null> {
  let latest: RouterCheckpoint | null = null;
  for await (const checkpoint of streamCheckpointsFromSessionPath(sessionPath)) latest = checkpoint;
  return latest;
}

function findConfiguredModel(ctx: any, target: string, currentProvider?: string): { model: any; matchedBy: "qualified" | "id" } | undefined {
  const all = ctx?.modelRegistry?.getAll?.() ?? [];
  const observedProvider = currentProvider?.toLowerCase();
  const byCurrentProviderId = observedProvider ? all.find((model: any) => model.id === target && String(model.provider).toLowerCase() === observedProvider) : undefined;
  if (byCurrentProviderId) return { model: byCurrentProviderId, matchedBy: "id" };
  const [provider, ...modelParts] = target.split("/");
  if (modelParts.length > 0) {
    const found = ctx?.modelRegistry?.find?.(provider, modelParts.join("/"));
    if (found) return { model: found, matchedBy: "qualified" };
    const byQualified = all.find((model: any) => `${model.provider}/${model.id}` === target);
    if (byQualified) return { model: byQualified, matchedBy: "qualified" };
  }
  const byId = all.filter((model: any) => model.id === target);
  return byId.length === 1 ? { model: byId[0], matchedBy: "id" } : undefined;
}

function configuredModelMatches(current: string | undefined, currentProvider: string | undefined, resolved: { model: any; matchedBy: "qualified" | "id" }): boolean {
  const model = resolved.model;
  if (!current || !model?.provider || !model?.id) return false;
  const c = current.toLowerCase();
  const provider = String(model.provider).toLowerCase();
  const id = String(model.id).toLowerCase();
  const observedProvider = currentProvider?.toLowerCase();
  if (observedProvider) {
    const currentModel = c.startsWith(`${observedProvider}/`) ? c.slice(observedProvider.length + 1) : c;
    return observedProvider === provider && currentModel === id;
  }
  return c === `${provider}/${id}` || (resolved.matchedBy === "id" && c === id);
}

export async function applyModelRouting(pi: Pick<ExtensionAPI, "setModel"> | undefined, ctx: any, summary: RouterObserveSummary): Promise<RouterModelApplySummary> {
  if (!summary.targetModel || summary.role === "none" || summary.role === "current") {
    return { applied: false, status: "policy_noop", reason: "no model switch for route action" };
  }
  const resolved = findConfiguredModel(ctx, summary.targetModel, summary.currentProvider);
  if (resolved?.matchedBy === "id" && modelsMatch(summary.currentModel, summary.targetModel, summary.currentProvider)) {
    return { applied: false, status: "policy_noop", reason: "current model already matches target", fromModel: summary.currentModel, toModel: summary.targetModel };
  }
  if (resolved && configuredModelMatches(summary.currentModel, summary.currentProvider, resolved)) {
    return { applied: false, status: "policy_noop", reason: "current model already matches target", fromModel: summary.currentModel, toModel: summary.targetModel };
  }
  if (!resolved && modelsMatch(summary.currentModel, summary.targetModel, summary.currentProvider)) {
    return { applied: false, status: "policy_noop", reason: "current model already matches target", fromModel: summary.currentModel, toModel: summary.targetModel };
  }
  if (!resolved) {
    return { applied: false, status: "blocked", reason: `target model not configured: ${summary.targetModel}`, fromModel: summary.currentModel, toModel: summary.targetModel };
  }
  const success = await pi?.setModel?.(resolved.model);
  if (!success) {
    return { applied: false, status: "blocked", reason: `target model unavailable or missing auth: ${summary.targetModel}`, fromModel: summary.currentModel, toModel: summary.targetModel };
  }
  return { applied: true, status: "applied", reason: summary.reason, fromModel: summary.currentModel, toModel: summary.targetModel };
}

function nowFromCheckpoint(checkpoint: RouterCheckpoint): number {
  const parsed = Date.parse(checkpoint.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function pruneSwitchHistory(history: string[] = [], nowMs: number, windowMs: number): string[] {
  const cutoff = nowMs - Math.max(1, windowMs);
  return history.filter((entry) => {
    const parsed = Date.parse(entry);
    return Number.isFinite(parsed) && parsed >= cutoff;
  });
}

export function planAutoModelSwitch(checkpoint: RouterCheckpoint, summary: RouterObserveSummary, state: RouterState, policy: RouterConfig["autoModel"]): AutoModelSwitchPlan {
  if (summary.match !== false || summary.role === "none" || summary.role === "current" || !summary.targetModel) {
    return {
      canApply: false,
      reason: "no model switch action",
      statePatch: {
        autoModelPendingTarget: summary.targetModel,
        autoModelPendingStreak: 0,
        autoModelSwitchHistory: state.autoModelSwitchHistory ?? [],
      },
    };
  }

  const targetModel = summary.targetModel;
  const nowMs = nowFromCheckpoint(checkpoint);
  const existingHistory = pruneSwitchHistory(state.autoModelSwitchHistory, nowMs, policy.switchWindowSeconds * 1000);
  const streak = state.autoModelPendingTarget === targetModel
    ? (state.autoModelPendingStreak ?? 0) + 1
    : 1;

  const statePatch: Partial<RouterState> = {
    autoModelPendingTarget: targetModel,
    autoModelPendingStreak: streak,
    autoModelSwitchHistory: existingHistory,
  };

  if (summary.confidence < policy.minConfidence) {
    return {
      canApply: false,
      reason: `confidence ${summary.confidence.toFixed(2)} below auto-model threshold ${policy.minConfidence.toFixed(2)}`,
      statePatch,
    };
  }

  if (streak < policy.requiredConsecutiveMismatches) {
    return {
      canApply: false,
      reason: `need ${policy.requiredConsecutiveMismatches} consecutive mismatches before switching (currently ${streak})`,
      statePatch,
    };
  }

  const lastSwitchMs = Date.parse(state.autoModelLastSwitchAt ?? "");
  if (Number.isFinite(lastSwitchMs) && nowMs - lastSwitchMs < policy.minCooldownSeconds * 1000) {
    return {
      canApply: false,
      reason: `cooldown not elapsed: ${policy.minCooldownSeconds}s`,
      statePatch,
    };
  }

  if (existingHistory.length >= policy.maxSwitchesPerWindow) {
    return {
      canApply: false,
      reason: `max auto-model flips exceeded: ${existingHistory.length}/${policy.maxSwitchesPerWindow} in ${policy.switchWindowSeconds}s`,
      statePatch,
    };
  }

  return {
    canApply: true,
    reason: "auto-model flip policy satisfied",
    statePatch,
  };
}

export function planAutoModelDowngrade(checkpoint: RouterCheckpoint, summary: RouterObserveSummary, state: RouterState, policy: RouterConfig["autoModel"], workerTarget?: string): AutoModelSwitchPlan {
  if (summary.role !== "current" || !summary.currentModel || !workerTarget) {
    return {
      canApply: false,
      reason: "no model switch action",
      statePatch: {
        autoModelPendingTarget: workerTarget,
        autoModelPendingStreak: 0,
        autoModelSwitchHistory: state.autoModelSwitchHistory ?? [],
      },
    };
  }

  if (modelsMatch(summary.currentModel, workerTarget, summary.currentProvider)) {
    return {
      canApply: false,
      reason: "current model already matches target",
      statePatch: {
        autoModelPendingTarget: workerTarget,
        autoModelPendingStreak: 0,
        autoModelSwitchHistory: state.autoModelSwitchHistory ?? [],
      },
    };
  }

  const nowMs = nowFromCheckpoint(checkpoint);
  const existingHistory = pruneSwitchHistory(state.autoModelSwitchHistory, nowMs, policy.switchWindowSeconds * 1000);
  const statePatch: Partial<RouterState> = {
    autoModelPendingTarget: workerTarget,
    autoModelPendingStreak: 0,
    autoModelSwitchHistory: existingHistory,
  };

  if (summary.confidence < policy.downgradeConfidence) {
    return {
      canApply: false,
      reason: `confidence ${summary.confidence.toFixed(2)} below auto-model downgrade threshold ${policy.downgradeConfidence.toFixed(2)}`,
      statePatch,
    };
  }

  const lastSwitchMs = Date.parse(state.autoModelLastSwitchAt ?? "");
  if (Number.isFinite(lastSwitchMs) && nowMs - lastSwitchMs < policy.minCooldownSeconds * 1000) {
    return {
      canApply: false,
      reason: `cooldown not elapsed before reverting to worker: ${policy.minCooldownSeconds}s`,
      statePatch,
    };
  }

  if (existingHistory.length >= policy.maxSwitchesPerWindow) {
    return {
      canApply: false,
      reason: `max auto-model flips exceeded: ${existingHistory.length}/${policy.maxSwitchesPerWindow} in ${policy.switchWindowSeconds}s`,
      statePatch,
    };
  }

  return {
    canApply: true,
    reason: "auto-model cooldown elapsed; reverting to worker",
    statePatch,
  };
}

export async function observeRouterTurn(ctx: any, pi?: Pick<ExtensionAPI, "setModel">): Promise<RouterObserveSummary | null> {
  const config = loadRouterConfig(ctx);
  if (!config.enabled || (config.print === "off" && config.mode === "observe")) return null;
  const sessionPath = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionPath) return null;
  const checkpoint = await latestCheckpointFromSession(String(sessionPath));
  if (!checkpoint) return null;
  const state = loadRouterState(ctx, String(sessionPath));
  if (state.lastObservedCheckpointId === checkpoint.checkpointId) return null;

  const liveCheckpoint = checkpointWithDiffStats(checkpoint, ctx?.cwd, [
    String(sessionPath),
    routerConfigPath(ctx),
    routerDir(ctx),
    routerStatePath(ctx, String(sessionPath)),
    routerEventsPath(ctx, String(sessionPath)),
  ]);
  const decision = decideRoute(liveCheckpoint);
  const summary = summarizeRouterDecision(liveCheckpoint, decision, config);
  const event = buildRouteEvent(liveCheckpoint, decision);

  const nextState: RouterState = {
    lastObservedCheckpointId: checkpoint.checkpointId,
    lastDecisionAction: decision.action,
    lastSummary: summary.text,
  };

  if (config.mode === "auto_model") {
    const profile = activeProfile(config);
    const workerTarget = resolvedProfileTarget("worker", profile).targetModel;
    const escalatePlan = planAutoModelSwitch(checkpoint, summary, state, config.autoModel);
    const downgradePlan = workerTarget ? planAutoModelDowngrade(checkpoint, summary, state, config.autoModel, workerTarget) : undefined;
    const plan = summary.match === false ? escalatePlan : downgradePlan ?? escalatePlan;
    const routingSummary = plan.canApply && summary.match === true && summary.role === "current" && workerTarget
      ? {
          ...summary,
          action: "continue_local" as const,
          role: "worker" as const,
          targetModel: workerTarget,
          match: modelsMatch(summary.currentModel, workerTarget, summary.currentProvider),
          confidence: Math.max(summary.confidence, config.autoModel.downgradeConfidence),
          reason: plan.reason,
        }
      : summary;

    const applySummary = plan.canApply
      ? await applyModelRouting(pi, ctx, routingSummary)
      : {
          applied: false,
          status: "policy_noop" as const,
          reason: plan.reason,
          fromModel: summary.currentModel,
          toModel: routingSummary.targetModel,
        };

    nextState.autoModelPendingTarget = plan.statePatch.autoModelPendingTarget;
    nextState.autoModelPendingStreak = plan.statePatch.autoModelPendingStreak;
    nextState.autoModelSwitchHistory = plan.statePatch.autoModelSwitchHistory;
    if (applySummary.applied) {
      nextState.autoModelLastSwitchAt = checkpoint.createdAt;
      nextState.autoModelPendingStreak = 0;
      nextState.autoModelSwitchHistory = [...(plan.statePatch.autoModelSwitchHistory ?? []), checkpoint.createdAt];
      ctx.ui?.notify?.(
        `router auto-model: APPLIED ${applySummary.fromModel ?? "unknown"} → ${applySummary.toModel ?? "none"} · ${applySummary.reason}`,
        "info",
      );
    } else if (plan.canApply) {
      event.observed.followed = false;
      event.observed.overriddenBy = applySummary.reason;
      event.observed.routingStatus = applySummary.status ?? (routingSummary.role === "worker" ? "downgraded" : "applied");
      ctx.ui?.notify?.(
        `router auto-model: SKIPPED ${applySummary.fromModel ?? "unknown"} → ${applySummary.toModel ?? "none"} · ${applySummary.reason}`,
        "warning",
      );
    } else if (summary.match === false) {
      event.observed.followed = false;
      event.observed.overriddenBy = applySummary.reason;
      event.observed.routingStatus = applySummary.status ?? "policy_noop";
      ctx.ui?.notify?.(
        `router auto-model: SKIPPED ${applySummary.fromModel ?? "unknown"} → ${applySummary.toModel ?? "none"} · ${applySummary.reason}`,
        "warning",
      );
    }

    if (applySummary.applied) {
      event.observed.followed = true;
      event.observed.routingStatus = routingSummary.role === "worker" ? "downgraded" : "applied";
    }
  }

  appendRouteEvent(routerEventsPath(ctx, String(sessionPath)), event);
  saveRouterState(ctx, {
    ...state,
    ...nextState,
  }, String(sessionPath));

  if (config.print === "mismatch_only" && summary.match !== false) return summary;
  if (config.print !== "off") ctx.ui?.notify?.(summary.text, summary.match === false ? "warning" : "info");
  return summary;
}
