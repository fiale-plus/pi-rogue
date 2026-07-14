export const MIN_AUTORESEARCH_CYCLES = 2;

export type ResearchCompletionState = { cycles?: number; evidenceCycles?: number };
export type ResearchCheckResult = "done" | "continue" | "unknown";

export function hasResearchCompletionEvidence(text: string): boolean {
  const clauses = String(text ?? "")
    .split(/[;\n]+|(?<=[.!?])\s+|\b(?:but|however)\b/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const negative = /\b(?:not verified|not validated|(?:has|have|had|was|were|is|are)?\s*not\s+(?:yet\s+)?(?:been\s+)?(?:run|verified|validated|executed|recorded)|hasn't (?:been )?run|haven't (?:been )?run|hadn't (?:been )?run|wasn't run|weren't run|did not run|pending|unavailable|unknown|tbd|no results?|without (?:a )?result|failed to run|could not run|unable to run)\b/i;
  const speculative = /\b(?:will|should|would|could|may|might|probably|presumably|expected to|likely(?: to)?|appears? to|seems? to)\s+(?:be\s+)?(?:run|recorded|pass(?:es|ed|ing)?|succeed(?:s|ed|ing)?|improv(?:es|ed|e|ing)?)\b/i;
  const packageCommand = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|eval|benchmark)\b.{0,120}\b(?:pass(?:ed|ing)?|fail(?:ed|ing)?|succeed(?:ed|ing)?|green|exit(?:ed)?\s*[01]|[0-9]+\s+(?:tests?|checks?|passing|failing)\b)\b/i;
  const ecosystemCommand = /\b(?:pytest|go\s+test|cargo\s+test|mvn(?:w)?\s+test|gradle(?:w)?\s+test|make\s+(?:test|check))\b.{0,160}\b(?:ok|pass(?:ed|ing)?|fail(?:ed|ing)?|succeed(?:ed|ing)?|build success|[0-9]+\s+(?:passed|passing|failed|failing))\b/i;
  const evaluatedResult = /\b(?:tests?|checks?|evaluation|eval|benchmark|validation)\b.{0,120}\b(?:pass(?:es|ed|ing)?|fail(?:s|ed|ing)?|succeed(?:s|ed|ing)?|successfully|green|improv(?:ed|ement)|regress(?:ed|ion))\b/i;
  const scoredResult = /\b(?:evaluation|eval|benchmark|validation)\b.{0,120}\bscore(?:d)?\s*(?::|=|of)?\s*\d+(?:\.\d+)?%?/i;
  const measuredResult = /\b(?:metric|accuracy|latency|throughput|error rate|score|baseline)\b.{0,120}\b(?:measur(?:ed|ement)|observed|improv(?:ed|ement)|increas(?:ed|e)|decreas(?:ed|e)|chang(?:ed|e)|unchanged|regress(?:ed|ion))\b.{0,120}\b\d+(?:\.\d+)?%?/i;
  const hasConcreteResult = (clause: string) => !negative.test(clause) && !speculative.test(clause) && (packageCommand.test(clause) || ecosystemCommand.test(clause) || evaluatedResult.test(clause) || scoredResult.test(clause) || measuredResult.test(clause));
  return clauses.some((clause, index) => hasConcreteResult(clause) || (clauses[index + 1] ? hasConcreteResult(`${clause} ${clauses[index + 1]}`) : false));
}

export function researchCompletionBlock(state: ResearchCompletionState, result: ResearchCheckResult, evidenceText: string): string | null {
  if (result !== "done") return null;
  const cycles = state.cycles ?? 0;
  if (cycles < MIN_AUTORESEARCH_CYCLES) return `autoresearch needs at least ${MIN_AUTORESEARCH_CYCLES} distinct cycles before completion; observed ${cycles}`;
  const evidenceCycles = state.evidenceCycles ?? 0;
  if (evidenceCycles < MIN_AUTORESEARCH_CYCLES) return `autoresearch needs evidence-backed results from at least ${MIN_AUTORESEARCH_CYCLES} distinct cycles; observed ${evidenceCycles}`;
  if (!hasResearchCompletionEvidence(evidenceText)) return "autoresearch completion needs explicit check, evaluation, benchmark, or metric evidence with a recorded result";
  return null;
}
