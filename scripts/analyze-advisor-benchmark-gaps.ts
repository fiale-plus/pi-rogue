#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

interface Row {
  mode?: string;
  name?: string;
  accuracy?: unknown;
  score?: unknown;
  total?: unknown;
  rows?: Array<Record<string, unknown>>;
}

interface RunSummary {
  file: string;
  source: string;
  items: Array<{ mode: string; accuracy: number; score?: number; total?: number; rows?: Array<Record<string, unknown>> }>;
}

interface GapResult {
  file: string;
  source: string;
  pair: string;
  leftMode: string;
  rightMode: string;
  leftAccuracy: number;
  rightAccuracy: number;
  absGap: number;
  relGapPercent: number;
}

const DEFAULT_SUMMARIES = [
  "/tmp/bench-hard/summary.json",
  "/tmp/bench-guided/summary.json",
  "/tmp/bench-guided2/summary.json",
  "/tmp/bench-modes/summary.json",
  "/tmp/bench-modes-v2/summary.json",
];

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function normalizeMode(row: Row): string | undefined {
  const mode = row.mode ?? row.name;
  return typeof mode === "string" ? mode : undefined;
}

function loadSummary(path: string): RunSummary | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSyncUtf8(path));
    if (!Array.isArray(raw)) {
      return null;
    }
    const items: RunSummary["items"] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const row = entry as Row;
      const mode = normalizeMode(row);
      if (!mode) {
        continue;
      }
      const accuracy = parseNumber(row.accuracy);
      if (accuracy === undefined) {
        continue;
      }
      const score = parseNumber(row.score);
      const total = parseNumber(row.total);
      items.push({ mode, accuracy, score, total, rows: row.rows as Array<Record<string, unknown>> | undefined });
    }
    return { file: path, source: basename(path), items };
  } catch {
    return null;
  }
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function computeGap(left: number, right: number): { absGap: number; relGapPercent: number } {
  const absGap = right - left;
  const rel = left !== 0 ? (absGap / left) * 100 : 0;
  return { absGap, relGapPercent: rel };
}

function getAccuracy(run: RunSummary, mode: string): number | undefined {
  return run.items.find((r) => r.mode === mode)?.accuracy;
}

function missedTaskList(run: RunSummary, mode: string): string[] {
  const item = run.items.find((r) => r.mode === mode);
  if (!item?.rows) return [];

  const misses: string[] = [];
  for (const r of item.rows) {
    const ok = r.ok === true;
    if (ok) continue;
    const task = r.task;
    const response = typeof r.response === "string" ? r.response : "";
    const expected = typeof r.expected === "string" ? r.expected : "";
    const label = task ? `${task}` : "unknown-task";
    misses.push(`${label}: "${response}" (expected ${expected})`);
  }
  return misses;
}

function printRunInsights(run: RunSummary): string {
  const pairs = [
    { left: "5.3_spark_no_advisor", right: "5.5_no_advisor", label: "regular-unassisted" },
    { left: "5.3_clean", right: "5.5_clean", label: "clean" },
    { left: "5.3_spark_advised_by_5.5", right: "5.3_spark_no_advisor", label: "advised-over-plain" },
  ] as const;

  const lines: string[] = ["", `## ${run.source}`, ""]; 
  for (const pair of pairs) {
    const leftAccuracy = getAccuracy(run, pair.left);
    const rightAccuracy = getAccuracy(run, pair.right);
    if (leftAccuracy === undefined || rightAccuracy === undefined) {
      continue;
    }
    const gap = computeGap(leftAccuracy, rightAccuracy);
    lines.push(`- ${pair.label}: ${pair.left}=${formatPercent(leftAccuracy)} vs ${pair.right}=${formatPercent(rightAccuracy)} => ${gap.absGap >= 0 ? "+" : ""}${gap.absGap.toFixed(3)} (${gap.relGapPercent.toFixed(2)}% rel)`);
  }

  const missRows = run.items.flatMap((item) => {
    if (!item.rows) return [] as string[];
    const misses = missedTaskList(run, item.mode);
    return misses.length
      ? misses.map((miss) => `${item.mode}: ${miss}`)
      : [];
  });

  if (missRows.length > 0) {
    lines.push("", "### Failing task snippets");
    for (const miss of missRows.slice(0, 12)) {
      lines.push(`- ${miss}`);
    }
    if (missRows.length > 12) {
      lines.push(`- ... (${missRows.length - 12} more) ...`);
    }
  }

  return lines.join("\n");
}

function toReportJson(
  summaries: RunSummary[],
  gaps: GapResult[],
  topGap: GapResult | undefined,
): string {
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFiles: summaries.map((s) => s.file),
    gaps,
    topGap,
    summaries: summaries.map((s) => ({
      file: s.source,
      modes: s.items.map((i) => ({ mode: i.mode, accuracy: i.accuracy, score: i.score, total: i.total })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function collectGaps(summaries: RunSummary[]): GapResult[] {
  const pairs = [
    { left: "5.3_spark_no_advisor", right: "5.5_no_advisor", pair: "regular-spark" },
    { left: "5.3_clean", right: "5.5_clean", pair: "clean" },
    { left: "5.3_spark_advised_by_5.5", right: "5.3_spark_no_advisor", pair: "advisor-vs-no-advisor" },
  ] as const;

  const gaps: GapResult[] = [];
  for (const summary of summaries) {
    for (const pair of pairs) {
      const left = getAccuracy(summary, pair.left);
      const right = getAccuracy(summary, pair.right);
      if (left === undefined || right === undefined) {
        continue;
      }
      const { absGap, relGapPercent } = computeGap(left, right);
      gaps.push({
        file: summary.source,
        source: summary.file,
        pair: pair.pair,
        leftMode: pair.left,
        rightMode: pair.right,
        leftAccuracy: left,
        rightAccuracy: right,
        absGap,
        relGapPercent,
      });
    }
  }
  return gaps;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function parseInputFiles(defaultFiles: string[]): string[] {
  const provided = parseArg("summaries");
  if (!provided) return defaultFiles;

  const arr = provided.split(",").map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : defaultFiles;
}

function parseOutPath(name: string, fallback: string): string {
  return parseArg(name) ?? fallback;
}

function main(): number {
  const summaryFiles = parseInputFiles(DEFAULT_SUMMARIES);
  const outJson = parseOutPath("out-json", "data/routing/advisor-benchmark-gap-report.json");
  const outMd = parseOutPath("out-md", "data/routing/advisor-benchmark-gap-report.md");

  const summaries = summaryFiles
    .map((file) => loadSummary(file))
    .filter((s): s is RunSummary => s !== null);

  if (summaries.length === 0) {
    console.error("No benchmark summary files could be loaded.");
    return 1;
  }

  const gaps = collectGaps(summaries);

  const topGap = gaps.reduce<GapResult | undefined>((best, item) => {
    if (!best) return item;
    return Math.abs(item.absGap) > Math.abs(best.absGap) ? item : best;
  }, undefined);

  const markdown: string[] = [
    "# Advisor benchmark gap report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Sources: ${summaries.length}`,
    "",
    "## Summary by run",
  ];

  for (const summary of summaries) {
    markdown.push(printRunInsights(summary));
  }

  if (topGap) {
    markdown.push("", "## Largest absolute gap", "");
    markdown.push(
      `- ${topGap.file}: ${topGap.leftMode} (${formatPercent(topGap.leftAccuracy)}) -> ${topGap.rightMode} (${formatPercent(
        topGap.rightAccuracy,
      )}) = ${topGap.absGap >= 0 ? "+" : ""}${topGap.absGap.toFixed(3)} abs (${topGap.relGapPercent.toFixed(2)}% rel)`,
    );
  }

  mkdirSync("data/routing", { recursive: true });
  writeFileSync(outJson, toReportJson(summaries, gaps, topGap));
  writeFileSync(outMd, `${markdown.join("\n")}\n`);

  console.log(`Wrote report: ${outJson}`);
  console.log(`Wrote report: ${outMd}`);

  console.log("\nTop gaps:");
  for (const gap of gaps) {
    const dir = gap.absGap >= 0 ? "gain" : "drop";
    console.log(`- ${gap.file} ${gap.pair}: ${gap.leftMode} ${formatPercent(gap.leftAccuracy)} -> ${gap.rightMode} ${formatPercent(gap.rightAccuracy)} (${gap.absGap.toFixed(3)} abs, ${gap.relGapPercent.toFixed(2)}% rel, ${dir})`);
  }

  if (topGap) {
    console.log(`\nLargest abs gap: ${topGap.file} ${topGap.pair} = ${topGap.absGap >= 0 ? "+" : ""}${topGap.absGap.toFixed(3)}`);
  }

  return 0;
}

process.exit(main());
