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
  const [targetProvider, ...targetModelParts] = t.split("/");
  if (targetModelParts.length > 0) {
    const targetModel = targetModelParts.join("/");
    if (provider) {
      const currentModel = c.startsWith(`${provider}/`) ? c.slice(provider.length + 1) : c;
      if (provider === targetProvider) return currentModel === targetModel;
      return currentModel === t;
    }
    if (c.includes("/")) return c === t;
    return false;
  }
  return c === t || modelLeaf(c) === modelLeaf(t) || c.endsWith(`/${modelLeaf(t)}`) || t.endsWith(`/${modelLeaf(c)}`);
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
  if (!summary.targetModel || summary.role === "none" || summary.role === "current") return { applied: false, reason: "no model switch for route action" };
  const resolved = findConfiguredModel(ctx, summary.targetModel, summary.currentProvider);
  if (resolved?.matchedBy === "id" && modelsMatch(summary.currentModel, summary.targetModel, summary.currentProvider)) return { applied: false, reason: "current model already matches target", fromModel: summary.currentModel, toModel: summary.targetModel };
  if (resolved && configuredModelMatches(summary.currentModel, summary.currentProvider, resolved)) return { applied: false, reason: "current model already matches target", fromModel: summary.currentModel, toModel: summary.targetModel };
  if (!resolved && modelsMatch(summary.currentModel, summary.targetModel, summary.currentProvider)) return { applied: false, reason: "current model already matches target", fromModel: summary.currentModel, toModel: summary.targetModel };
  if (!resolved) return { applied: false, reason: `target model not configured: ${summary.targetModel}`, fromModel: summary.currentModel, toModel: summary.targetModel };
  const success = await pi?.setModel?.(resolved.model);
  if (!success) return { applied: false, reason: `target model unavailable or missing auth: ${summary.targetModel}`, fromModel: summary.currentModel, toModel: summary.targetModel };
  return { applied: true, reason: summary.reason, fromModel: summary.currentModel, toModel: summary.targetModel };
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
  appendRouteEvent(routerEventsPath(ctx, String(sessionPath)), buildRouteEvent(liveCheckpoint, decision));
  saveRouterState(ctx, {
    lastObservedCheckpointId: checkpoint.checkpointId,
    lastDecisionAction: decision.action,
    lastSummary: summary.text,
  }, String(sessionPath));

  if (config.mode === "auto_model") {
    const applied = await applyModelRouting(pi, ctx, summary);
    if (applied.applied || summary.match === false) {
      ctx.ui?.notify?.(`router auto-model: ${applied.applied ? "APPLIED" : "SKIPPED"} ${applied.fromModel ?? "unknown"} → ${applied.toModel ?? "none"} · ${applied.reason}`, applied.applied ? "info" : "warning");
    }
  }

  if (config.print === "mismatch_only" && summary.match !== false) return summary;
  if (config.print !== "off") ctx.ui?.notify?.(summary.text, summary.match === false ? "warning" : "info");
  return summary;
}
