import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const ROOT_DIR = join(homedir(), ".pi", "agent", "fiale-plus");

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
