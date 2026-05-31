import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contentText, readText, sessionFile, truncate, writeText } from "./internal.js";

const FEATURE = "orchestration";
const STATE_FILE = "novelty-guard.json";
const MAX_USER_TURNS = 8;
const MAX_ASSISTANT_TURNS = 6;
const DUPLICATE_THRESHOLD = 0.72;
const CONTAINMENT_THRESHOLD = 0.82;

const STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "with",
  "this",
  "from",
  "have",
  "has",
  "are",
  "was",
  "were",
  "been",
  "being",
  "only",
  "appears",
  "appear",
  "agent",
  "repo",
  "side",
]);

const TRUNCATED_SUFFIXES = new Set([
  "but",
  "however",
  "although",
  "though",
  "because",
  "while",
  "and",
  "or",
  "with",
  "without",
  "remain",
  "remaining",
  "original",
  "orig",
  "ori",
  "closeout",
  "closeou",
  "benchmark",
  "benc",
  "bench",
  "promotion",
  "promoti",
  "promot",
  "evaluation",
  "evalua",
  "eval",
  "evidence",
  "eviden",
  "artifacts",
  "artif",
  "committed",
  "commi",
  "synced",
  "synce",
  "clean",
  "clea",
  "optional",
  "opti",
  "repository",
  "reposi",
]);

export interface NoveltyGuardTurn {
  at: string;
  text: string;
}

export interface NoveltyGuardAssistantTurn extends NoveltyGuardTurn {
  statusConfirmation: boolean;
}

export interface NoveltyGuardState {
  recentUserTurns: NoveltyGuardTurn[];
  recentAssistantTurns: NoveltyGuardAssistantTurn[];
}

export type NoveltyGuardDecision =
  | { action: "continue" }
  | { action: "duplicate"; message: string; similarity: number }
  | { action: "clarify_truncated"; message: string };

export function defaultNoveltyGuardState(): NoveltyGuardState {
  return { recentUserTurns: [], recentAssistantTurns: [] };
}

export function normalizeTurn(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(text: string): string[] {
  const normalized = normalizeTurn(text);
  const tokens = normalized
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));

  if (/\bautoresearch\b/.test(normalized)) tokens.push("topic_autoresearch");
  if (/\b(repo side|repository side)\b/.test(normalized)) tokens.push("scope_repo_side");
  if (/\b(closed|complete|completed|verified|done)\b/.test(normalized)) tokens.push("state_closed");
  if (/\b(promoted|promotion|binary gate|model)\b/.test(normalized)) tokens.push("artifact_model");
  if (/\b(runtime|sync|synced)\b/.test(normalized)) tokens.push("artifact_runtime_sync");
  if (/\b(eval|evaluation|artifacts|evidence|committed)\b/.test(normalized)) tokens.push("artifact_eval_evidence");

  return tokens;
}

export function turnSimilarity(a: string, b: string): number {
  const left = new Set(meaningfulTokens(a));
  const right = new Set(meaningfulTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }

  const union = left.size + right.size - overlap;
  const jaccard = union > 0 ? overlap / union : 0;
  const containment = overlap / Math.min(left.size, right.size);
  let score = Math.max(jaccard, containment * 0.92);

  const statusFeatures = ["topic_autoresearch", "scope_repo_side", "state_closed", "artifact_model", "artifact_runtime_sync", "artifact_eval_evidence"];
  const sharedStatusFeatures = statusFeatures.filter((feature) => left.has(feature) && right.has(feature)).length;
  if (sharedStatusFeatures >= 5) score = Math.max(score, 0.84);
  else if (sharedStatusFeatures >= 4) score = Math.max(score, 0.78);

  return score;
}

export function looksTruncatedPrompt(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (raw.length < 48) return false;
  if (/[.!?)]$/.test(raw)) return false;

  const normalized = normalizeTurn(raw);
  if (!normalized) return false;
  const words = normalized.split(" ").filter(Boolean);
  const last = words.at(-1) ?? "";
  const previous = words.at(-2) ?? "";

  if (TRUNCATED_SUFFIXES.has(last)) return true;
  if (last.length <= 4 && /^(repo|auto|model|run|eval|comm|prom|sync|clos|orig|benc|evid|arti|opti|rema)/.test(last)) return true;
  if ((previous === "but" || previous === "however") && words.length >= 8) return true;

  return false;
}

export function isStatusConfirmation(text: string): boolean {
  const normalized = normalizeTurn(text);
  if (!normalized) return false;

  const hasSubject = /\b(autoresearch|repo side|repo side|repository side|binary gate|promoted model|runtime sync|eval artifacts)\b/.test(normalized);
  const hasClosed = /\b(closed|complete|completed|verified|clean status|status closed|done)\b/.test(normalized);
  const hasNoAction = /\b(optional external|rollout|ci smoke|no remaining|only remaining|no repo side)\b/.test(normalized);
  return hasSubject && hasClosed && (hasNoAction || normalized.length < 900);
}

function recentStatusConfirmationCount(state: NoveltyGuardState): number {
  return state.recentAssistantTurns.slice(-4).filter((turn) => turn.statusConfirmation).length;
}

function hasConcreteNewAction(text: string): boolean {
  const normalized = normalizeTurn(text);
  return /\b(now|next|please|can you|could you)\b.*\b(run|draft|write|implement|add|create|inspect|check|verify|test|commit|open|prepare)\b/.test(normalized)
    || /\b(run|draft|write|implement|add|create|inspect|verify|test|commit|prepare)\b.*\b(rollout|rollback|release|checklist|config|command|test|smoke|pr|note|notes)\b/.test(normalized);
}

export function evaluateNoveltyGuard(input: string, state: NoveltyGuardState): NoveltyGuardDecision {
  const text = String(input ?? "").trim();
  if (!text) return { action: "continue" };

  if (looksTruncatedPrompt(text)) {
    return {
      action: "clarify_truncated",
      message: "That looks truncated, so I won't infer the missing request. Please send the specific delta or action you want.",
    };
  }

  if (hasConcreteNewAction(text)) {
    return { action: "continue" };
  }

  const recentUsers = state.recentUserTurns.slice(-MAX_USER_TURNS);
  const similarity = recentUsers.reduce((max, turn) => Math.max(max, turnSimilarity(text, turn.text)), 0);
  const lastAssistantConfirmed = state.recentAssistantTurns.at(-1)?.statusConfirmation === true;
  const repeatedConfirmations = recentStatusConfirmationCount(state) >= 2;

  if (similarity >= DUPLICATE_THRESHOLD && (lastAssistantConfirmed || repeatedConfirmations)) {
    return {
      action: "duplicate",
      similarity,
      message: "Already verified; no new delta detected. Please specify a concrete new action, new evidence to inspect, or say stop.",
    };
  }

  return { action: "continue" };
}

export function recordUserTurn(state: NoveltyGuardState, text: string): NoveltyGuardState {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return state;
  return {
    ...state,
    recentUserTurns: [...state.recentUserTurns, { at: new Date().toISOString(), text: truncate(trimmed, 1200) }].slice(-MAX_USER_TURNS),
  };
}

export function recordAssistantTurn(state: NoveltyGuardState, text: string): NoveltyGuardState {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return state;
  return {
    ...state,
    recentAssistantTurns: [
      ...state.recentAssistantTurns,
      { at: new Date().toISOString(), text: truncate(trimmed, 1200), statusConfirmation: isStatusConfirmation(trimmed) },
    ].slice(-MAX_ASSISTANT_TURNS),
  };
}

function parseState(raw: string): NoveltyGuardState {
  if (!raw.trim()) return defaultNoveltyGuardState();
  try {
    const parsed = JSON.parse(raw) as Partial<NoveltyGuardState>;
    return {
      recentUserTurns: Array.isArray(parsed.recentUserTurns) ? parsed.recentUserTurns.filter((turn) => typeof turn?.text === "string").slice(-MAX_USER_TURNS) : [],
      recentAssistantTurns: Array.isArray(parsed.recentAssistantTurns)
        ? parsed.recentAssistantTurns
            .filter((turn) => typeof turn?.text === "string")
            .map((turn) => ({ ...turn, statusConfirmation: Boolean((turn as NoveltyGuardAssistantTurn).statusConfirmation) }))
            .slice(-MAX_ASSISTANT_TURNS)
        : [],
    };
  } catch {
    return defaultNoveltyGuardState();
  }
}

function readGuardState(ctx: any): NoveltyGuardState {
  return parseState(readText(sessionFile(FEATURE, ctx, STATE_FILE)));
}

function writeGuardState(ctx: any, state: NoveltyGuardState): void {
  writeText(sessionFile(FEATURE, ctx, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function registerNoveltyGuard(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    const text = String(event?.text ?? "").trim();
    if (!text || text.startsWith("/") || event?.source === "extension") {
      return { action: "continue" };
    }

    const state = readGuardState(ctx);
    const decision = evaluateNoveltyGuard(text, state);
    writeGuardState(ctx, recordUserTurn(state, text));

    if (decision.action === "continue") {
      return { action: "continue" };
    }

    ctx.ui.notify(decision.message, "info");
    return { action: "handled" };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role !== "assistant") return;
    const text = contentText(event.message.content);
    if (!text) return;
    writeGuardState(ctx, recordAssistantTurn(readGuardState(ctx), text));
  });
}
