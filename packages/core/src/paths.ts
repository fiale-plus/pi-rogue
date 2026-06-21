import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

const ROOT_DIR = join(homedir(), ".pi", "agent", "fiale-plus");

function legacySessionKey(ctx: any): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionFile) return "session";
  return basename(String(sessionFile)).replace(/\.[^.]+$/, "");
}

function sessionStorageKey(text: string): string {
  const legacy = String(text || "session");
  const slug = legacy
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "") || "session";
  const hash = createHash("sha256").update(legacy).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
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
  return legacySessionKey(ctx);
}

export function sessionDir(feature: string, ctx: any): string {
  const root = featureDir(feature);
  const legacyKey = legacySessionKey(ctx);
  const currentDir = join(root, sessionStorageKey(legacyKey));
  const legacyDir = join(root, legacyKey);
  const relativeLegacyDir = relative(root, legacyDir);
  if (relativeLegacyDir && !relativeLegacyDir.startsWith("..") && existsSync(legacyDir) && !existsSync(currentDir)) return legacyDir;
  mkdirSync(currentDir, { recursive: true });
  return currentDir;
}

export function featureFile(feature: string, filename: string): string {
  return join(featureDir(feature), filename);
}

export function sessionFile(feature: string, ctx: any, filename: string): string {
  return join(sessionDir(feature, ctx), filename);
}
