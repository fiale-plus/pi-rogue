#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forwardedArgs = process.argv.slice(2).filter((arg) => arg !== "--runInBand" && arg !== "--");
const command = ["vitest", "run", ...forwardedArgs].join(" ");
const result = spawnSync("sh", ["-lc", command], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
