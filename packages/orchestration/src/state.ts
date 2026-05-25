import { readText, sessionFile, writeText } from "./internal.js";

export function readSessionText(feature: string, ctx: any, file: string): string {
  return readText(sessionFile(feature, ctx, file)).trim();
}

export function writeSessionText(feature: string, ctx: any, file: string, text: string): void {
  writeText(sessionFile(feature, ctx, file), text ? `${text}\n` : "");
}

export function readSessionJson<T>(feature: string, ctx: any, file: string, fallback: T): T {
  const raw = readSessionText(feature, ctx, file);
  if (!raw) return fallback;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeSessionJson(feature: string, ctx: any, file: string, value: unknown): void {
  writeText(sessionFile(feature, ctx, file), `${JSON.stringify(value, null, 2)}\n`);
}
