#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY = [
  ["@fiale-plus/pi-rogue-bundle", "Deprecated: replaced by @fiale-plus/pi-rogue. Install via \"pi install npm:@fiale-plus/pi-rogue\"."],
  ["@fiale-plus/pi-rogue-advisor", "Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via \"pi install npm:@fiale-plus/pi-rogue\"."],
  ["@fiale-plus/pi-rogue-orchestration", "Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via \"pi install npm:@fiale-plus/pi-rogue\"."],
  ["@fiale-plus/pi-orchestration", "Deprecated: replaced by @fiale-plus/pi-rogue. Install via \"pi install npm:@fiale-plus/pi-rogue\"."],
];
const npm = process.env.NPM_CLI || "npm";
const verifyOnly = process.argv.includes("--verify-only");
const retryDelayMs = Number(process.env.DEPRECATION_RETRY_DELAY_MS || 2_000);
let viewCount = 0;

function npmOutput(args) {
  const result = spawnSync(npm, args, { encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `npm ${args[0]} failed`).trim());
  return result.stdout.trim();
}

function jsonView(spec, field) {
  const cache = join(process.env.RUNNER_TEMP || tmpdir(), `pi-rogue-deprecation-cache-${process.pid}-${viewCount++}`);
  const output = npmOutput(["view", spec, field, "--json", "--registry=https://registry.npmjs.org/", "--prefer-online", `--cache=${cache}`]);
  return output ? JSON.parse(output) : undefined;
}

function versionsFor(name) {
  const value = jsonView(name, "versions");
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function mismatches(name, versions, expected) {
  return versions.flatMap((version) => {
    const actual = jsonView(`${name}@${version}`, "deprecated");
    return actual === expected ? [] : [{ version, actual: actual ?? "<unset>" }];
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withRetry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.error(`${label}: attempt ${attempt} failed; retrying: ${error.message}`);
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(`${label} failed after 3 attempts: ${lastError.message}`);
}

for (const [name, message] of LEGACY) {
  const versions = await withRetry(`${name}: version discovery`, () => versionsFor(name));
  let wrong = await withRetry(`${name}: deprecation verification`, () => mismatches(name, versions, message));
  if (wrong.length === 0) {
    console.log(`${name}: all ${versions.length} version(s) already have the exact deprecation message`);
    continue;
  }
  if (verifyOnly) throw new Error(`${name}: deprecation mismatch: ${JSON.stringify(wrong)}`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let writeError;
    try {
      npmOutput(["deprecate", `${name}@*`, message, "--registry=https://registry.npmjs.org/"]);
    } catch (error) {
      writeError = error;
    }

    try {
      wrong = mismatches(name, versions, message);
      if (wrong.length === 0) {
        console.log(`${name}: exact deprecation verified for ${versions.length} version(s)${writeError ? " after a non-fatal write response" : ""}`);
        lastError = undefined;
        break;
      }
      lastError = writeError || new Error(`verification mismatch: ${JSON.stringify(wrong)}`);
    } catch (verificationError) {
      lastError = writeError
        ? new Error(`${writeError.message}; verification also failed: ${verificationError.message}`)
        : verificationError;
    }
    if (attempt < 3) {
      console.error(`${name}: attempt ${attempt} failed; retrying: ${lastError.message}`);
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }
  if (lastError) throw new Error(`${name}: deprecation failed after 3 attempts: ${lastError.message}`);
}
