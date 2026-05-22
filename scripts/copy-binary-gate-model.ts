#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const SRC = path.join(process.cwd(), "data", "routing", "binary-gate-model.json");
const DST = path.join(HOME, ".pi", "agent", "fiale-plus", "advisor", "binary-gate-model.json");

if (!fs.existsSync(SRC)) {
  console.error(`Model not found at ${SRC}. Run npm run binary:train first.`);
  process.exitCode = 1;
} else {
  fs.mkdirSync(path.dirname(DST), { recursive: true });
  fs.copyFileSync(SRC, DST);
  console.log(`Copied binary gate model to ${DST}`);
}
