import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const ROOT_DIR = join(homedir(), ".pi", "agent", "fiale-plus");

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function ensureParent(filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}

export function readText(filePath: string, fallback = ""): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export function writeText(filePath: string, text: string): void {
  ensureParent(filePath);
  writeFileSync(filePath, text, "utf8");
}

export function appendText(filePath: string, text: string): void {
  ensureParent(filePath);
  appendFileSync(filePath, text, "utf8");
}

export function appDir(): string {
  mkdirSync(ROOT_DIR, { recursive: true });
  return ROOT_DIR;
}

export function featureDir(feature: string): string {
  const dir = join(appDir(), feature);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionKey(ctx: any): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionFile) return "session";
  return basename(String(sessionFile)).replace(/\.[^.]+$/, "");
}

export function sessionDir(feature: string, ctx: any): string {
  const dir = join(featureDir(feature), sessionKey(ctx));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function featureFile(feature: string, filename: string): string {
  return join(featureDir(feature), filename);
}

export function sessionFile(feature: string, ctx: any, filename: string): string {
  return join(sessionDir(feature, ctx), filename);
}
