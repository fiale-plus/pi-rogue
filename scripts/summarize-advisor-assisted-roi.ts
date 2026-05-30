#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface AdvisorValueReport {
  generatedAt?: string;
  summaries?: Array<{
    summaryFile?: string;
    sparkMode?: string;
    frontierMode?: string | null;
    assistedMode?: string | null;
    rows?: number;
    labelCounts?: { continue?: number; escalate?: number };
    accuracies?: { spark?: number; frontier?: number | null; assisted?: number | null; oracleValueGate?: number };
    costsPerTask?: { spark?: number | null; frontier?: number | null; assisted?: number | null; oracleSparseAdvisor?: number | null };
    advisorCallRate?: number;
  }>;
}

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return `$${v.toFixed(6)}`;
}

function ratio(n: number | null | undefined, d: number | null | undefined): number | null {
  if (n === null || n === undefined || d === null || d === undefined || d === 0) return null;
  return n / d;
}

function main(): number {
  const input = parseArg("input", "data/routing/advisor-value-benchmark-report.json");
  const outJson = parseArg("out-json", "data/routing/advisor-assisted-roi-report.json");
  const outMd = parseArg("out-md", "data/routing/advisor-assisted-roi-report.md");

  if (!existsSync(input)) {
    console.error(`Missing input report: ${input}. Run npm run advisor-value:build first.`);
    return 1;
  }

  const report = JSON.parse(readFileSync(input, "utf8")) as AdvisorValueReport;
  const rows = (report.summaries ?? []).map((summary) => {
    const sparkAcc = summary.accuracies?.spark ?? 0;
    const frontierAcc = summary.accuracies?.frontier ?? null;
    const sparseAcc = summary.accuracies?.oracleValueGate ?? 0;
    const assistedAcc = summary.accuracies?.assisted ?? null;
    const sparkCost = summary.costsPerTask?.spark ?? null;
    const frontierCost = summary.costsPerTask?.frontier ?? null;
    const sparseCost = summary.costsPerTask?.oracleSparseAdvisor ?? null;
    const assistedCost = summary.costsPerTask?.assisted ?? null;
    const qualityVsFrontier = ratio(sparseAcc, frontierAcc);
    const costVsFrontier = ratio(sparseCost, frontierCost);
    const costVsSpark = ratio(sparseCost, sparkCost);
    const alwaysAdvisedCostVsFrontier = ratio(assistedCost, frontierCost);
    const alwaysAdvisedQualityVsFrontier = ratio(assistedAcc, frontierAcc);
    const frontierMatched = frontierAcc !== null && sparseAcc >= frontierAcc * 0.95;
    const cheaperThanFrontier = frontierCost !== null && sparseCost !== null && sparseCost < frontierCost;

    return {
      summaryFile: summary.summaryFile,
      rows: summary.rows ?? 0,
      advisorCallRate: summary.advisorCallRate ?? 0,
      spark: { mode: summary.sparkMode, accuracy: sparkAcc, costPerTask: sparkCost },
      frontier: { mode: summary.frontierMode, accuracy: frontierAcc, costPerTask: frontierCost },
      alwaysAdvised: { mode: summary.assistedMode, accuracy: assistedAcc, costPerTask: assistedCost, qualityVsFrontier: alwaysAdvisedQualityVsFrontier, costVsFrontier: alwaysAdvisedCostVsFrontier },
      sparseAdvisorOracle: { accuracy: sparseAcc, costPerTask: sparseCost, qualityVsFrontier, costVsFrontier, costVsSpark },
      verdict: frontierMatched && cheaperThanFrontier ? "demo-positive" : frontierMatched ? "quality-positive-cost-neutral" : "needs-more-work",
    };
  });

  const aggregate = rows.reduce((acc, row) => {
    const n = row.rows || 0;
    acc.rows += n;
    acc.sparkCorrect += (row.spark.accuracy ?? 0) * n;
    acc.frontierCorrect += (row.frontier.accuracy ?? 0) * n;
    acc.sparseCorrect += row.sparseAdvisorOracle.accuracy * n;
    acc.sparkCost += (row.spark.costPerTask ?? 0) * n;
    acc.frontierCost += (row.frontier.costPerTask ?? 0) * n;
    acc.sparseCost += (row.sparseAdvisorOracle.costPerTask ?? 0) * n;
    acc.advisorCalls += row.advisorCallRate * n;
    return acc;
  }, { rows: 0, sparkCorrect: 0, frontierCorrect: 0, sparseCorrect: 0, sparkCost: 0, frontierCost: 0, sparseCost: 0, advisorCalls: 0 });

  const aggregateMetrics = {
    rows: aggregate.rows,
    advisorCallRate: aggregate.rows ? aggregate.advisorCalls / aggregate.rows : 0,
    sparkAccuracy: aggregate.rows ? aggregate.sparkCorrect / aggregate.rows : 0,
    frontierAccuracy: aggregate.rows ? aggregate.frontierCorrect / aggregate.rows : 0,
    sparseAdvisorAccuracy: aggregate.rows ? aggregate.sparseCorrect / aggregate.rows : 0,
    sparkCostPerTask: aggregate.rows ? aggregate.sparkCost / aggregate.rows : 0,
    frontierCostPerTask: aggregate.rows ? aggregate.frontierCost / aggregate.rows : 0,
    sparseAdvisorCostPerTask: aggregate.rows ? aggregate.sparseCost / aggregate.rows : 0,
  };
  const aggregateQualityVsFrontier = ratio(aggregateMetrics.sparseAdvisorAccuracy, aggregateMetrics.frontierAccuracy);
  const aggregateCostVsFrontier = ratio(aggregateMetrics.sparseAdvisorCostPerTask, aggregateMetrics.frontierCostPerTask);
  const aggregateCostVsSpark = ratio(aggregateMetrics.sparseAdvisorCostPerTask, aggregateMetrics.sparkCostPerTask);

  const payload = {
    generatedAt: new Date().toISOString(),
    input,
    aggregate: {
      ...aggregateMetrics,
      qualityVsFrontier: aggregateQualityVsFrontier,
      costVsFrontier: aggregateCostVsFrontier,
      costVsSpark: aggregateCostVsSpark,
      demoPass: Boolean(aggregateQualityVsFrontier !== null && aggregateQualityVsFrontier >= 0.95 && aggregateCostVsFrontier !== null && aggregateCostVsFrontier < 1),
    },
    rows,
    successCriteria: {
      primary: "sparse Spark+5.5 reaches >=95% of 5.5-only quality and costs less than 5.5-only",
      preferredCost: "<=80% of 5.5-only cost on benchmark/demo slices; <=25% incremental cost over Spark in regular sessions",
      regularSessionBudget: "1-5% no-tool 5.5 advisor turns; <=10% 5.5 no-tool token ratio",
    },
  };

  const md: string[] = [
    "# Advisor-assisted ROI report",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## Demo question",
    "",
    "Can a 5.3 Spark session assisted only at key points by 5.5 get close to 5.5-only quality while costing less than running the whole session on 5.5?",
    "",
    "## Aggregate",
    "",
    `- Rows: ${aggregateMetrics.rows}`,
    `- Advisor call rate: ${pct(aggregateMetrics.advisorCallRate)}`,
    `- Spark quality/cost: ${pct(aggregateMetrics.sparkAccuracy)} / ${money(aggregateMetrics.sparkCostPerTask)} per task`,
    `- 5.5-only quality/cost: ${pct(aggregateMetrics.frontierAccuracy)} / ${money(aggregateMetrics.frontierCostPerTask)} per task`,
    `- Sparse advisor quality/cost: ${pct(aggregateMetrics.sparseAdvisorAccuracy)} / ${money(aggregateMetrics.sparseAdvisorCostPerTask)} per task`,
    `- Sparse quality vs 5.5-only: ${pct(aggregateQualityVsFrontier)}`,
    `- Sparse cost vs 5.5-only: ${pct(aggregateCostVsFrontier)}`,
    `- Sparse cost vs Spark: ${pct(aggregateCostVsSpark)}`,
    `- Demo pass: ${payload.aggregate.demoPass ? "yes" : "no"}`,
    "",
    "## Slices",
    "",
    "| Source | Spark | 5.5-only | Sparse assisted | Call rate | Sparse / 5.5 quality | Sparse / 5.5 cost | Verdict |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];

  for (const row of rows) {
    md.push(`| ${row.summaryFile ?? "unknown"} | ${pct(row.spark.accuracy)} / ${money(row.spark.costPerTask)} | ${pct(row.frontier.accuracy)} / ${money(row.frontier.costPerTask)} | ${pct(row.sparseAdvisorOracle.accuracy)} / ${money(row.sparseAdvisorOracle.costPerTask)} | ${pct(row.advisorCallRate)} | ${pct(row.sparseAdvisorOracle.qualityVsFrontier)} | ${pct(row.sparseAdvisorOracle.costVsFrontier)} | ${row.verdict} |`);
  }

  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });
  writeFileSync(outJson, JSON.stringify(payload, null, 2) + "\n");
  writeFileSync(outMd, md.join("\n") + "\n");

  console.log(`aggregate quality vs 5.5: ${pct(aggregateQualityVsFrontier)}`);
  console.log(`aggregate cost vs 5.5: ${pct(aggregateCostVsFrontier)}`);
  console.log(`advisor call rate: ${pct(aggregateMetrics.advisorCallRate)}`);
  console.log(`demo pass: ${payload.aggregate.demoPass ? "yes" : "no"}`);
  console.log(`report: ${outJson}`);
  console.log(`markdown: ${outMd}`);
  return 0;
}

process.exit(main());
