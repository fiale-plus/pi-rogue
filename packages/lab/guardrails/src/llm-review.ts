import { scanShellCommand, type RiskScan } from "@fiale-plus/pi-core";

/**
 * Fallback: estimate risk via heuristic even without an LLM call.
 * When LLM review is enabled, this stub can be replaced with a
 * `pi.ai.generate` call that produces a structured risk verdict.
 */
export type LlmVerdict = "allow" | "block" | "ask";

export interface LlmReviewResult {
  verdict: LlmVerdict;
  reasoning: string;
}

/**
 * Dummy LLM review — returns a structured verdict based on the heuristic scan.
 *
 * Replace the body with a real LLM call when wiring:
 *
 * ```ts
 * const response = await pi.ai.generate({
 *   messages: [
 *     { role: "system", content: "You evaluate shell command risk..." },
 *     { role: "user", content: command }
 *   ]
 * });
 * return JSON.parse(response.text);
 * ```
 */
export async function llmReview(
  command: string,
  scan: RiskScan,
  extraFragments: string[],
): Promise<LlmReviewResult> {
  // Stub: mirrors the heuristic result.
  // Swap this for a real pi.ai.generate() call when provider is available.
  if (scan.safe) {
    return { verdict: "allow", reasoning: scan.reason };
  }

  if (scan.severity === "danger") {
    return { verdict: "block", reasoning: scan.reason };
  }

  return { verdict: "ask", reasoning: scan.reason };
}
