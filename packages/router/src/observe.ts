import { appendRouteEvent, buildRouteEvent } from "./ledger.js";
import { decideRoute } from "./decision.js";
import { checkpointWithDiffStats, streamCheckpointsFromSessionPath } from "./checkpoints.js";
import {
  activeProfile,
  loadRouterConfig,
  loadRouterState,
  routerConfigPath,
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
  match: boolean | null;
  confidence: number;
  reason: string;
  text: string;
}

function squish(text: unknown, max = 140): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export function actionRole(action: RouteAction): RouterObserveSummary["role"] {
  switch (action) {
    case "continue_current": return "current";
    case "continue_local": return "worker";
    case "summarize_context": return "worker";
    case "run_verifier": return "worker";
    case "ask_micro_hint": return "smart";
    case "escalate_plan_critique": return "smart";
    case "escalate_debug_diagnosis": return "smart";
    case "escalate_diff_review": return "reviewer";
    case "delegate_full_step": return "smart";
    case "spawn_subagent": return "smart";
    case "merge_subagent_result": return "current";
    case "stop_and_ask_user": return "none";
  }
}

function modelLeaf(model: string): string {
  return model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
}

export function modelsMatch(current: string | undefined, target: string | undefined): boolean | null {
  if (!current || !target) return null;
  const c = current.toLowerCase();
  const t = target.toLowerCase();
  return c === t || modelLeaf(c) === modelLeaf(t) || c.endsWith(`/${modelLeaf(t)}`) || t.endsWith(`/${modelLeaf(c)}`);
}

function targetForRole(role: RouterObserveSummary["role"], profile: RouterProfile, currentModel?: string): string | undefined {
  if (role === "current") return currentModel;
  if (role === "none") return undefined;
  return profile[role];
}

export function summarizeRouterDecision(checkpoint: RouterCheckpoint, decision: RouteDecision, config: RouterConfig): RouterObserveSummary {
  const profile = activeProfile(config);
  const role = actionRole(decision.action);
  const targetModel = targetForRole(role, profile, checkpoint.activeModel);
  const match = role === "none" ? null : modelsMatch(checkpoint.activeModel, targetModel);
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

export async function observeRouterTurn(ctx: any): Promise<RouterObserveSummary | null> {
  const config = loadRouterConfig(ctx);
  if (!config.enabled || config.print === "off") return null;
  const sessionPath = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionPath) return null;
  const checkpoint = await latestCheckpointFromSession(String(sessionPath));
  if (!checkpoint) return null;
  const state = loadRouterState(ctx);
  if (state.lastObservedCheckpointId === checkpoint.checkpointId) return null;

  const liveCheckpoint = checkpointWithDiffStats(checkpoint, ctx?.cwd, [sessionPath, routerConfigPath(ctx), routerStatePath(ctx), routerEventsPath(ctx)]);
  const decision = decideRoute(liveCheckpoint);
  const summary = summarizeRouterDecision(liveCheckpoint, decision, config);
  appendRouteEvent(routerEventsPath(ctx), buildRouteEvent(liveCheckpoint, decision));
  saveRouterState(ctx, {
    lastObservedCheckpointId: checkpoint.checkpointId,
    lastDecisionAction: decision.action,
    lastSummary: summary.text,
  });

  if (config.print === "mismatch_only" && summary.match !== false) return summary;
  ctx.ui?.notify?.(summary.text, summary.match === false ? "warning" : "info");
  return summary;
}
