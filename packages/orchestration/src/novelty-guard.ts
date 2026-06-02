import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contentText, readText, sessionFile, truncate, writeText } from "./internal.js";

const FEATURE = "orchestration";
const STATE_FILE = "repetition-guard.json";
const MAX_ASSISTANT_TURNS = 6;
const REPEAT_COUNT = 3;
const REPEAT_THRESHOLD = 0.8;

export interface RepetitionGuardTurn {
  at: string;
  text: string;
}

export interface RepetitionGuardRepeat {
  at: string;
  count: number;
  text: string;
}

export interface RepetitionGuardState {
  recentAssistantTurns: RepetitionGuardTurn[];
  assistantRepeat?: RepetitionGuardRepeat;
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

export function recordAssistantTurn(state: RepetitionGuardState, text: string): RepetitionGuardState {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return state;
  const next: RepetitionGuardState = {
    ...state,
    recentAssistantTurns: [...state.recentAssistantTurns, { at: new Date().toISOString(), text: truncate(trimmed, 1200) }].slice(-MAX_ASSISTANT_TURNS),
  };
  const repeat = detectAssistantRepetition(next);
  return repeat ? { ...next, assistantRepeat: repeat } : { ...next, assistantRepeat: undefined };
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

export function registerNoveltyGuard(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueNoveltyGuardRegistered) return;
  p.__piRogueNoveltyGuardRegistered = true;

  pi.on("before_agent_start", async (event, ctx) => {
    const state = readGuardState(ctx);
    const repeat = detectAssistantRepetition(state) ?? state.assistantRepeat;
    if (!repeat) return { systemPrompt: event.systemPrompt };

    return {
      systemPrompt: [
        event.systemPrompt,
        "Pi-Rogue repetition guard:",
        `The previous assistant output repeated ${repeat.count} times: ${truncate(repeat.text, 180)}`,
        "Inspect current state before continuing, then apply only the smallest missing delta. Do not repeat the same response.",
      ].join("\n\n"),
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role !== "assistant") return;
    const text = contentText(event.message.content);
    if (!text) return;

    const previous = readGuardState(ctx);
    const next = recordAssistantTurn(previous, text);
    writeGuardState(ctx, next);
    if (next.assistantRepeat && (!previous.assistantRepeat || next.assistantRepeat.count > previous.assistantRepeat.count)) {
      ctx.ui.notify("Repetition guard detected repeated assistant output; the next turn will inspect current state before retrying.", "warning");
    }
  });
}
