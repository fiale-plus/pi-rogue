#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateCloseoutCases, normalizeEvaluationCases, renderCloseoutEvaluationMarkdown } from "../packages/advisor/src/closeout-eval.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = argument("--input");
if (!input) throw new Error("Usage: npm run evaluate:advisor -- --input <fixture.json> [--json-output <report.json>] [--markdown-output <report.md>]");

const payload = JSON.parse(readFileSync(resolve(input), "utf8")) as unknown;
const cases = normalizeEvaluationCases(payload);
if (cases.length === 0) throw new Error("Evaluation input contains no valid closeout cases");
const report = evaluateCloseoutCases(cases);
const jsonOutput = argument("--json-output");
const markdownOutput = argument("--markdown-output");
if (jsonOutput) writeFileSync(resolve(jsonOutput), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (markdownOutput) writeFileSync(resolve(markdownOutput), renderCloseoutEvaluationMarkdown(report), "utf8");
if (!jsonOutput && !markdownOutput) process.stdout.write(`${renderCloseoutEvaluationMarkdown(report)}\n`);
