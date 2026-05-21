import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureParent(filePath: string): string {
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

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = readText(filePath).trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
