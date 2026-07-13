#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}

const tests = walk(path.join(root, "packages")).filter((file) => file.endsWith(".test.ts"));
const scripts = walk(path.join(root, "scripts")).filter((file) => file.endsWith(".ts"));
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const vitestConfig = fs.readFileSync(path.join(root, "vitest.config.ts"), "utf8");
const listedScriptFiles = new Set(
  execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.scripts.json", "--noEmit", "--listFilesOnly"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => path.resolve(file)),
);

const failures: string[] = [];
if (rootPackage.scripts?.test !== "vitest run") failures.push("root test script must be exactly `vitest run` so recursive Vitest discovery is authoritative");
if (!vitestConfig.includes('include: ["packages/**/src/**/*.test.ts"]')) failures.push("vitest.config.ts must recursively include packages/**/src/**/*.test.ts");
if (/exclude:\s*\[[^\]]*\.test\.ts/s.test(vitestConfig.split("coverage:")[0] || "")) failures.push("Vitest test discovery must not exclude checked-in test files");
for (const test of tests) {
  if (!test.includes(`${path.sep}src${path.sep}`)) failures.push(`test is outside the authoritative recursive include: ${path.relative(root, test)}`);
}
for (const script of scripts) {
  if (!listedScriptFiles.has(path.resolve(script))) failures.push(`script is absent from resolved TypeScript program: ${path.relative(root, script)}`);
}
if (failures.length) throw new Error(`Validation coverage contract failed:\n${failures.join("\n")}`);
console.log(`validation coverage: ${tests.length} package tests and ${scripts.length} scripts gated`);
