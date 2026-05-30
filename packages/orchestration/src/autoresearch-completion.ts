const MIN_AUTORESEARCH_CYCLES_DEFAULT = 2;

export type ResearchCheckResult = "done" | "continue" | "unknown";

export type ResearchCompletionState = {
  cycles?: number;
};

function coercePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

export function getMinAutoresearchCycles(): number {
  return coercePositiveInt(process.env.PI_ROGUE_AUTORESEARCH_MIN_CYCLES, MIN_AUTORESEARCH_CYCLES_DEFAULT);
}

export function hasResearchCompletionEvidence(text: string): boolean {
  return /\b(npm run|npm test|check|test|eval(?:uation)?|benchmark|metric|measur|release|published|installed|PR #|merged|cycle|log|summary)\b/i.test(text);
}

export function shouldHoldResearchOpen(state: ResearchCompletionState, result: ResearchCheckResult, text: string): string | null {
  if (result !== "done") return null;
  const cycles = state.cycles ?? 0;
  const requiredCycles = getMinAutoresearchCycles();
  if (cycles < requiredCycles) {
    return `autoresearch needs at least ${requiredCycles} cycles before auto-completion; observed ${cycles}`;
  }
  if (!hasResearchCompletionEvidence(text)) {
    return "autoresearch completion needs explicit check/evaluation/metric evidence";
  }
  return null;
}
