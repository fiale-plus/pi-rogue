#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBudgetBoardSmoke } from "../packages/advisor/src/budget-board-smoke.js";

type SmokeModel = { provider: string; id: string; input: string[] };

function discoverPiModels(): SmokeModel[] {
  const result = spawnSync("pi", ["--list-models", "--offline"], { encoding: "utf8" });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 && !text.trim()) return [];
  const models: SmokeModel[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("provider ") || trimmed.startsWith("---")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const [provider, id] = parts;
    if (!provider || !id || provider === "provider" || id === "model") continue;
    models.push({ provider, id, input: ["text"] });
  }
  return models;
}

const tempRoot = mkdtempSync(join(tmpdir(), "pi-rogue-budget-board-smoke-"));
try {
  const result = runBudgetBoardSmoke({ tempRoot, models: discoverPiModels() });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
