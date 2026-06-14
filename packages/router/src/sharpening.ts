import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashText } from "./hash.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import { readOutcomes, type RouterOutcome } from "./outcomes.js";
import type { ModelCapabilityCard } from "./learning.js";
import type { RouteAction, TaskStatus } from "./types.js";

export const ROUTER_SHARPENING_HINTS_SCHEMA = "pi-router.sharpening-hints.v1" as const;

export type RouterSharpeningHintKind = "prefer_model_for_action" | "savings_candidate" | "mismatch_followup";
export type RouterSharpeningConfidence = "low" | "medium" | "high";

export interface RouterSharpeningHint {
  hintId: string;
  kind: RouterSharpeningHintKind;
  action?: RouteAction;
  modelId: string;
  provider?: string;
  confidence: RouterSharpeningConfidence;
  score: number;
  rationale: string;
  guardrails: {
    manualPromotionOnly: true;
    sampleSizeCapped: boolean;
    sparse: boolean;
  };
  provenance: {
    events: number;
    sessions: number;
    linkedOutcomes: number;
    outcomeStatus: Record<TaskStatus, number>;
    eventIds: string[];
    checkpointIds: string[];
    cardEvents?: number;
    comparedWith?: Array<{ modelId: string; provider?: string; score: number; events: number }>;
  };
}

export interface RouterSharpeningArtifact {
  schema: typeof ROUTER_SHARPENING_HINTS_SCHEMA;
  generatedAt: string;
  inputs: { events: string; outcomes?: string; cards?: string };
  totals: { events: number; outcomes: number; cards: number; sessions: number; models: number };
  hints: RouterSharpeningHint[];
  manualPromotionRequired: true;
}

interface GroupStats {
  action?: RouteAction;
  provider?: string;
  modelId: string;
  events: RouteEvent[];
  sessions: Set<string>;
  outcomeStatus: Record<TaskStatus, number>;
  linkedOutcomes: RouterOutcome[];
  averageProgressScore: number;
  averageLoopScore: number;
  score: number;
}

const OUTCOME_SCORE: Record<TaskStatus, number> = {
  success: 1,
  partial: 0.6,
  unknown: 0.45,
  abandoned: 0.15,
  failed: 0,
};

function emptyOutcomeStatus(): Record<TaskStatus, number> {
  return { success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0 };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stableSample<T>(values: T[], max = 8): T[] {
  return values.slice(0, max);
}

function modelKey(provider: string | undefined, modelId: string): string {
  return `${provider ?? "unknown"}\0${modelId}`;
}

function modelDisplay(provider: string | undefined, modelId: string): string {
  return provider && provider !== "unknown" ? `${provider}/${modelId}` : modelId;
}

function isLocalOrCheap(modelId: string, provider?: string): boolean {
  return /(local|ollama|mlx|qwen|llama|mistral|phi|codex-spark|spark)/i.test(`${provider ?? ""}/${modelId}`);
}

function confidence(events: number, linkedOutcomes: number, score: number): RouterSharpeningConfidence {
  if (events < 5 || linkedOutcomes === 0 || score < 0.65) return "low";
  if (events >= 20 && linkedOutcomes >= 5 && score >= 0.75) return "high";
  return "medium";
}

function outcomeMaps(outcomes: RouterOutcome[]): { byEvent: Map<string, RouterOutcome>; byCheckpoint: Map<string, RouterOutcome> } {
  return {
    byEvent: new Map(outcomes.flatMap((outcome) => outcome.routeEventId ? [[outcome.routeEventId, outcome] as const] : [])),
    byCheckpoint: new Map(outcomes.flatMap((outcome) => outcome.checkpointId && !outcome.routeEventId ? [[outcome.checkpointId, outcome] as const] : [])),
  };
}

function computeStats(action: RouteAction | undefined, provider: string | undefined, modelId: string, events: RouteEvent[], outcomes: RouterOutcome[]): GroupStats {
  const maps = outcomeMaps(outcomes);
  const linked = events.flatMap((event) => {
    const outcome = maps.byEvent.get(event.eventId) ?? maps.byCheckpoint.get(event.checkpointId);
    return outcome ? [outcome] : [];
  });
  const outcomeStatus = emptyOutcomeStatus();
  for (const outcome of linked) outcomeStatus[outcome.taskStatus]++;
  const progress = average(events.map((event) => event.metrics.progressScore));
  const loop = average(events.map((event) => event.metrics.loopScore));
  const signalScore = (progress + (1 - loop)) / 2;
  const outcomeScore = linked.length ? average(linked.map((outcome) => OUTCOME_SCORE[outcome.taskStatus])) : signalScore;
  return {
    action,
    provider,
    modelId,
    events,
    sessions: new Set(events.map((event) => event.sessionId)),
    outcomeStatus,
    linkedOutcomes: linked,
    averageProgressScore: round(progress),
    averageLoopScore: round(loop),
    score: round((outcomeScore * 0.65) + (signalScore * 0.35)),
  };
}

function groupedByActionModel(events: RouteEvent[], outcomes: RouterOutcome[]): GroupStats[] {
  const groups = new Map<string, RouteEvent[]>();
  for (const event of events) {
    const modelId = event.runtime.activeModel ?? "unknown";
    const key = `${event.decision.action}\0${modelKey(event.runtime.provider, modelId)}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [action, provider, modelId] = key.split("\0") as [RouteAction, string, string];
    return computeStats(action, provider === "unknown" ? undefined : provider, modelId, group, outcomes);
  });
}

function groupedByModel(events: RouteEvent[], outcomes: RouterOutcome[]): GroupStats[] {
  const groups = new Map<string, RouteEvent[]>();
  for (const event of events) {
    const modelId = event.runtime.activeModel ?? "unknown";
    const key = modelKey(event.runtime.provider, modelId);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [provider, modelId] = key.split("\0") as [string, string];
    return computeStats(undefined, provider === "unknown" ? undefined : provider, modelId, group, outcomes);
  });
}

function baseHint(kind: RouterSharpeningHintKind, stats: GroupStats, rationale: string, comparedWith?: RouterSharpeningHint["provenance"]["comparedWith"], cardEvents?: number): RouterSharpeningHint {
  const eventIds = stableSample([...new Set(stats.events.map((event) => event.eventId))].sort());
  const checkpointIds = stableSample([...new Set(stats.events.map((event) => event.checkpointId))].sort());
  const sparse = stats.events.length < 5 || stats.linkedOutcomes.length === 0;
  return {
    hintId: hashText("sharpen", kind, stats.action ?? "any", stats.provider ?? "unknown", stats.modelId, String(stats.events.length), String(stats.score)),
    kind,
    action: stats.action,
    modelId: stats.modelId,
    provider: stats.provider,
    confidence: confidence(stats.events.length, stats.linkedOutcomes.length, stats.score),
    score: stats.score,
    rationale,
    guardrails: { manualPromotionOnly: true, sampleSizeCapped: sparse, sparse },
    provenance: {
      events: stats.events.length,
      sessions: stats.sessions.size,
      linkedOutcomes: stats.linkedOutcomes.length,
      outcomeStatus: stats.outcomeStatus,
      eventIds,
      checkpointIds,
      ...(cardEvents === undefined ? {} : { cardEvents }),
      ...(comparedWith?.length ? { comparedWith } : {}),
    },
  };
}

function hasPoorLinkedOutcomes(stats: GroupStats): boolean {
  const negative = stats.outcomeStatus.failed + stats.outcomeStatus.abandoned;
  const positive = stats.outcomeStatus.success + stats.outcomeStatus.partial;
  return stats.linkedOutcomes.length > 0 && negative > 0 && positive === 0;
}

function readCapabilityCards(path?: string): ModelCapabilityCard[] {
  if (!path) return [];
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`capability cards file not found: ${path}`);
  return readFileSync(resolved, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const card = JSON.parse(line) as ModelCapabilityCard;
        if (card.schema !== "pi-router.model-capability-card.v1") throw new Error("invalid schema");
        return card;
      } catch (error) {
        throw new Error(`invalid capability card at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function cardMap(cards: ModelCapabilityCard[]): Map<string, ModelCapabilityCard> {
  return new Map(cards.map((card) => [modelKey(card.provider, card.modelId), card]));
}

export function generateSharpeningHints(options: { events: RouteEvent[]; outcomes?: RouterOutcome[]; cards?: ModelCapabilityCard[]; generatedAt?: string; inputs?: RouterSharpeningArtifact["inputs"] }): RouterSharpeningArtifact {
  const events = [...options.events].sort((a, b) => a.eventId.localeCompare(b.eventId));
  const outcomes = options.outcomes ?? [];
  const cards = options.cards ?? [];
  const byCard = cardMap(cards);
  const hints: RouterSharpeningHint[] = [];
  const byAction = new Map<RouteAction, GroupStats[]>();
  for (const stats of groupedByActionModel(events, outcomes)) {
    byAction.set(stats.action!, [...(byAction.get(stats.action!) ?? []), stats]);
  }

  for (const [action, groups] of [...byAction.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = groups.sort((a, b) => b.score - a.score || b.events.length - a.events.length || modelDisplay(a.provider, a.modelId).localeCompare(modelDisplay(b.provider, b.modelId)));
    if (sorted.length < 2) continue;
    const [best, runnerUp] = sorted;
    if (!best || !runnerUp || best.score - runnerUp.score < 0.05) continue;
    const comparedWith = sorted.slice(1, 4).map((stats) => ({ modelId: stats.modelId, provider: stats.provider, score: stats.score, events: stats.events.length }));
    hints.push(baseHint(
      "prefer_model_for_action",
      best,
      `${modelDisplay(best.provider, best.modelId)} leads historical ${action} samples (score ${best.score}, progress ${best.averageProgressScore}, loop ${best.averageLoopScore}) over ${modelDisplay(runnerUp.provider, runnerUp.modelId)} (score ${runnerUp.score}).`,
      comparedWith,
      byCard.get(modelKey(best.provider, best.modelId))?.observed.events,
    ));
  }

  for (const stats of groupedByModel(events, outcomes).sort((a, b) => b.score - a.score || modelDisplay(a.provider, a.modelId).localeCompare(modelDisplay(b.provider, b.modelId)))) {
    const card = byCard.get(modelKey(stats.provider, stats.modelId));
    const cardProgressOk = card ? card.observed.averageProgressScore >= 0.65 && card.observed.averageLoopScore <= 0.35 : true;
    if (!isLocalOrCheap(stats.modelId, stats.provider) || stats.events.length < 3 || stats.averageProgressScore < 0.65 || stats.averageLoopScore > 0.35 || stats.score < 0.65 || hasPoorLinkedOutcomes(stats) || !cardProgressOk) continue;
    hints.push(baseHint(
      "savings_candidate",
      stats,
      `${modelDisplay(stats.provider, stats.modelId)} looks safe to keep exploring for routine/worker traffic: ${stats.events.length} events, progress ${stats.averageProgressScore}, loop ${stats.averageLoopScore}. This is a manual hint, not an automatic promotion.`,
      undefined,
      card?.observed.events,
    ));
  }

  const overridden = events.filter((event) => event.observed.followed === false || event.observed.overriddenBy);
  if (overridden.length > 0) {
    const groups = new Map<string, RouteEvent[]>();
    for (const event of overridden) {
      const modelId = event.runtime.activeModel ?? "unknown";
      const key = `${event.decision.action}\0${modelKey(event.runtime.provider, modelId)}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    for (const [key, group] of [...groups.entries()].sort()) {
      const [action, provider, modelId] = key.split("\0") as [RouteAction, string, string];
      const stats = computeStats(action, provider === "unknown" ? undefined : provider, modelId, group, outcomes);
      hints.push(baseHint(
        "mismatch_followup",
        stats,
        `${group.length} ${action} observations were explicitly not followed or overridden on ${modelDisplay(stats.provider, stats.modelId)}; inspect before trusting future auto-routing for this slice.`,
      ));
    }
  }

  const sortedHints = hints.sort((a, b) => {
    const kind = a.kind.localeCompare(b.kind);
    if (kind) return kind;
    return b.score - a.score || (a.action ?? "").localeCompare(b.action ?? "") || modelDisplay(a.provider, a.modelId).localeCompare(modelDisplay(b.provider, b.modelId));
  });

  return {
    schema: ROUTER_SHARPENING_HINTS_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    inputs: options.inputs ?? { events: "<memory>" },
    totals: {
      events: events.length,
      outcomes: outcomes.length,
      cards: cards.length,
      sessions: new Set(events.map((event) => event.sessionId)).size,
      models: new Set(events.map((event) => modelKey(event.runtime.provider, event.runtime.activeModel ?? "unknown"))).size,
    },
    hints: sortedHints,
    manualPromotionRequired: true,
  };
}

export function writeSharpeningHints(options: { eventsPath: string; outputPath: string; outcomesPath?: string; cardsPath?: string; generatedAt?: string }): RouterSharpeningArtifact {
  if (!existsSync(resolve(options.eventsPath))) throw new Error(`required route events file not found: ${options.eventsPath}`);
  const events = readRouteEvents(options.eventsPath);
  const outcomes = readOutcomes(options.outcomesPath);
  const cards = readCapabilityCards(options.cardsPath);
  const artifact = generateSharpeningHints({
    events,
    outcomes,
    cards,
    generatedAt: options.generatedAt,
    inputs: { events: options.eventsPath, outcomes: options.outcomesPath, cards: options.cardsPath },
  });
  const resolved = resolve(options.outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
