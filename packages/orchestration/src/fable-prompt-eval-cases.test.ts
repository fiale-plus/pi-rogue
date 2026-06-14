import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PromptEvalCase {
  id: string;
  area: string;
  targetSurface: string;
  userPrompt: string;
  expectedBehavior: string[];
  failureSignals: string[];
}

interface PromptEvalSuite {
  schemaVersion: number;
  source: string;
  issue: number;
  purpose: string;
  promptCandidate?: string;
  modelFamilies: string[];
  cases: PromptEvalCase[];
}

const evalPath = resolve(__dirname, "../../../docs/prompt-evals/fable5-portability-cases.json");

function loadSuite(): PromptEvalSuite {
  return JSON.parse(readFileSync(evalPath, "utf8")) as PromptEvalSuite;
}

describe("Fable prompt portability eval cases", () => {
  it("keeps the eval suite valid and broadly model-family scoped", () => {
    const suite = loadSuite();

    expect(suite.schemaVersion).toBe(1);
    expect(suite.issue).toBe(139);
    expect(suite.source).toContain("CLAUDE-FABLE-5.md");
    expect(suite.promptCandidate).toBe("packages/core/src/prompt-policy.ts#buildPiRogueSystemPromptV1");
    expect(suite.modelFamilies).toEqual(expect.arrayContaining(["gpt", "qwen_oss", "open_weight_sota"]));
    expect(suite.cases.length).toBeGreaterThanOrEqual(8);
  });

  it("defines actionable expectations and failure signals for every case", () => {
    const suite = loadSuite();
    const ids = new Set<string>();

    for (const testCase of suite.cases) {
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
      expect(testCase.area).toBeTruthy();
      expect(testCase.targetSurface).toBeTruthy();
      expect(testCase.userPrompt).toBeTruthy();
      expect(testCase.expectedBehavior.length).toBeGreaterThanOrEqual(2);
      expect(testCase.failureSignals.length).toBeGreaterThanOrEqual(1);
    }
  });
});
