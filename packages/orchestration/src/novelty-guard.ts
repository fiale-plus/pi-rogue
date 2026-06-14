import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contentText, readText, sessionFile, truncate, writeText } from "./internal.js";

const FEATURE = "orchestration";
const STATE_FILE = "repetition-guard.json";
const MAX_ASSISTANT_TURNS = 6;
const REPEAT_COUNT = 3;
const REPEAT_THRESHOLD = 0.8;
const NO_PROGRESS_COUNT = 3;
const BOUNDED_RECOVERY_COUNT = 5;

export interface RepetitionGuardTurn {
  at: string;
  text: string;
}

export interface RepetitionGuardRepeat {
  at: string;
  count: number;
  text: string;
}

export interface NoProgressSignal {
  at: string;
  count: number;
  text: string;
  reason: string;
}

export interface RepetitionGuardState {
  recentAssistantTurns: RepetitionGuardTurn[];
  assistantRepeat?: RepetitionGuardRepeat;
  noProgress?: NoProgressSignal;
}

export function defaultRepetitionGuardState(): RepetitionGuardState {
  return { recentAssistantTurns: [] };
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

export function turnSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTurn(a).split(" ").filter((token) => token.length > 2));
  const right = new Set(normalizeTurn(b).split(" ").filter((token) => token.length > 2));
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.min(left.size, right.size);
}

export function detectAssistantRepetition(state: RepetitionGuardState, minCount = REPEAT_COUNT): RepetitionGuardRepeat | null {
  const recent = state.recentAssistantTurns.slice(-MAX_ASSISTANT_TURNS);
  const last = recent.at(-1);
  if (!last || normalizeTurn(last.text).length < 16) return null;

  let count = 1;
  for (let index = recent.length - 2; index >= 0; index--) {
    const candidate = recent[index];
    if (!candidate || normalizeTurn(candidate.text).length < 16) break;
    if (normalizeTurn(candidate.text) !== normalizeTurn(last.text) && turnSimilarity(last.text, candidate.text) < REPEAT_THRESHOLD) break;
    count++;
  }

  if (count < minCount) return null;
  return {
    at: new Date().toISOString(),
    count,
    text: truncate(last.text, 240),
  };
}

export function looksLikeNoProgressTurn(text: string): boolean {
  const normalized = normalizeTurn(text);
  if (normalized.length < 24) return false;

  const planning = /\b(i will|i'll|let me|going to|we need to|we should|next i|plan|planning|approach|think through|summarize|restate)\b/i.test(text);
  if (!planning) return false;

  const concreteProgress = /\b(changed|edited|created|wrote|updated|implemented|removed|ran|tested|passed|failed|verified|validated|found|inspected|read|opened|committed|pushed|fixed|completed|result|error|diff)\b/i.test(text);
  return !concreteProgress;
}

export function recordAssistantTurn(state: RepetitionGuardState, text: string, options: { activeOrchestration?: boolean } = {}): RepetitionGuardState {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return state;
  const next: RepetitionGuardState = {
    ...state,
    recentAssistantTurns: [...state.recentAssistantTurns, { at: new Date().toISOString(), text: truncate(trimmed, 1200) }].slice(-MAX_ASSISTANT_TURNS),
  };
  const repeat = detectAssistantRepetition(next);
  const noProgressCount = options.activeOrchestration && looksLikeNoProgressTurn(trimmed)
    ? (state.noProgress?.count ?? 0) + 1
    : 0;

  return {
    ...next,
    assistantRepeat: repeat ?? undefined,
    noProgress: noProgressCount > 0
      ? {
          at: new Date().toISOString(),
          count: noProgressCount,
          text: truncate(trimmed, 240),
          reason: "repeated planning/self-talk without concrete progress while orchestration is active",
        }
      : undefined,
  };
}

function parseState(raw: string): RepetitionGuardState {
  if (!raw.trim()) return defaultRepetitionGuardState();
  try {
    const parsed = JSON.parse(raw) as Partial<RepetitionGuardState>;
    return {
      recentAssistantTurns: Array.isArray(parsed.recentAssistantTurns)
        ? parsed.recentAssistantTurns.filter((turn) => typeof turn?.text === "string").slice(-MAX_ASSISTANT_TURNS)
        : [],
      assistantRepeat: parsed.assistantRepeat && typeof parsed.assistantRepeat.text === "string"
        ? {
            at: String(parsed.assistantRepeat.at ?? new Date().toISOString()),
            count: Number(parsed.assistantRepeat.count) || REPEAT_COUNT,
            text: parsed.assistantRepeat.text,
          }
        : undefined,
      noProgress: parsed.noProgress && typeof parsed.noProgress.text === "string"
        ? {
            at: String(parsed.noProgress.at ?? new Date().toISOString()),
            count: Number(parsed.noProgress.count) || NO_PROGRESS_COUNT,
            text: parsed.noProgress.text,
            reason: String(parsed.noProgress.reason ?? "no concrete progress detected"),
          }
        : undefined,
    };
  } catch {
    return defaultRepetitionGuardState();
  }
}

function readGuardState(ctx: any): RepetitionGuardState {
  return parseState(readText(sessionFile(FEATURE, ctx, STATE_FILE)));
}

function writeGuardState(ctx: any, state: RepetitionGuardState): void {
  writeText(sessionFile(FEATURE, ctx, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function clearNoProgressRecovery(ctx: any): void {
  const state = readGuardState(ctx);
  if (!state.noProgress) return;
  writeGuardState(ctx, { ...state, noProgress: undefined });
}

function hasActiveOrchestration(ctx: any): boolean {
  if (readText(sessionFile(FEATURE, ctx, "goal.md")).trim()) return true;
  for (const file of ["loop.json", "autoresearch.json"]) {
    try {
      const parsed = JSON.parse(readText(sessionFile(FEATURE, ctx, file), "{}"));
      if (parsed?.enabled || parsed?.instruction) return true;
    } catch {
      // ignore malformed state files; they should not trigger recovery
    }
  }
  return false;
}

function recoveryPrompt(repeat?: RepetitionGuardRepeat, noProgress?: NoProgressSignal): string | null {
  if (noProgress && noProgress.count < NO_PROGRESS_COUNT) noProgress = undefined;
  if (!repeat && !noProgress) return null;
  const count = Math.max(repeat?.count ?? 0, noProgress?.count ?? 0);
  const bounded = count >= BOUNDED_RECOVERY_COUNT;
  const signal = repeat
    ? `Repeated assistant output (${repeat.count} turns): ${truncate(repeat.text, 180)}`
    : `No-progress streak (${noProgress?.count} turns): ${truncate(noProgress?.text ?? "", 180)}`;

  return [
    bounded ? "Pi-Rogue bounded no-progress recovery:" : "Pi-Rogue no-progress recovery:",
    signal,
    noProgress?.reason ? `Reason: ${noProgress.reason}.` : "Reason: repeated output suggests the current approach is stuck.",
    bounded
      ? "Recovery is bounded now: do not stack another retry. If one safe, concrete alternative action is available, take exactly that action; otherwise stop and ask the user for direction with the current blocker."
      : "Summarize the current state in one sentence, choose one concrete alternative action, and take it now. Do not only restate the plan or repeat the same response.",
  ].join("\n");
}

export function registerNoveltyGuard(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueNoveltyGuardRegistered) return;
  p.__piRogueNoveltyGuardRegistered = true;

  pi.on("before_agent_start", async (event, ctx) => {
    const state = readGuardState(ctx);
    const active = hasActiveOrchestration(ctx);
    const noProgress = active ? state.noProgress : undefined;
    if (!active && state.noProgress) {
      clearNoProgressRecovery(ctx);
    }
    const prompt = recoveryPrompt(detectAssistantRepetition(state) ?? state.assistantRepeat, noProgress);
    if (!prompt) return { systemPrompt: event.systemPrompt };

    return {
      systemPrompt: [event.systemPrompt, prompt].join("\n\n"),
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role !== "assistant") return;
    const text = contentText(event.message.content);
    if (!text) return;

    const previous = readGuardState(ctx);
    const next = recordAssistantTurn(previous, text, { activeOrchestration: hasActiveOrchestration(ctx) });
    writeGuardState(ctx, next);
    if (next.assistantRepeat && (!previous.assistantRepeat || next.assistantRepeat.count > previous.assistantRepeat.count)) {
      ctx.ui.notify("Repetition guard detected repeated assistant output; the next turn will inspect current state before retrying.", "warning");
    }
    if (next.noProgress && next.noProgress.count >= NO_PROGRESS_COUNT && (!previous.noProgress || next.noProgress.count > previous.noProgress.count)) {
      ctx.ui.notify("No-progress recovery detected repeated planning without concrete progress; the next turn will take one alternative action or stop.", "warning");
    }
  });
}
