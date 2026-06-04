import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ROOT_DIR = join(homedir(), ".pi", "agent", "pi-rogue");

export function appDir(): string {
  mkdirSync(ROOT_DIR, { recursive: true });
  return ROOT_DIR;
}

export function featureDir(feature: string): string {
  const dir = join(appDir(), feature);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function featureFile(feature: string, filename: string): string {
  return join(featureDir(feature), filename);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function readText(filePath: string, fallback = ""): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function ensureParent(filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}

export function writeText(filePath: string, text: string): void {
  ensureParent(filePath);
  writeFileSync(filePath, text, "utf8");
}

export function appendText(filePath: string, text: string): void {
  ensureParent(filePath);
  appendFileSync(filePath, text, "utf8");
}

/** Write text atomically: write to temp file, then rename. Falls back to direct write on failure. */
export function atomicWriteText(filePath: string, text: string): void {
  const tempPath = filePath + ".tmp";
  try {
    writeText(tempPath, text);
    try { renameSync(tempPath, filePath); } catch {
      // If rename fails (e.g., cross-device), fall back to overwrite
      writeText(filePath, text);
    }
  } catch {
    // If temp write fails, try direct write
    writeText(filePath, text);
  }
}
