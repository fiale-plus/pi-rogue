import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const ROOT_DIR = join(homedir(), ".pi", "agent", "fiale-plus");
const SESSION_IDENTITY_VERSION = "v2";

type SessionIdentity = {
  key: string;
  legacyKey: string;
  priorCoreKey: string;
};

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  const suffix: string[] = [];
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  let canonicalBase = existing;
  try {
    canonicalBase = realpathSync.native(existing);
  } catch {
    // Fall back to the normalized absolute ancestor when realpath is unavailable.
  }
  return join(canonicalBase, ...suffix);
}

function rawSessionIdentity(ctx: any): { kind: "file" | "id"; value: string; label: string } | undefined {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (typeof sessionFile === "string" && sessionFile.length > 0) {
    const canonical = canonicalPath(sessionFile);
    return {
      kind: "file",
      value: canonical,
      label: basename(canonical).replace(/\.[^.]+$/, ""),
    };
  }

  const sessionId = ctx?.session?.id || process.env.PI_ROGUE_SESSION_ID;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return { kind: "id", value: sessionId, label: sessionId };
  }

  return undefined;
}

function safeLegacyKey(text: string): string {
  const safe = String(text || "session").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "session";
}

function storageSlug(text: string): string {
  return String(text || "session")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "") || "session";
}

function priorCoreStorageKey(text: string): string {
  const legacy = String(text || "session");
  const hash = createHash("sha256").update(legacy).digest("hex").slice(0, 8);
  return `${storageSlug(legacy)}-${hash}`;
}

export function sessionIdentity(ctx: any): SessionIdentity {
  const identity = rawSessionIdentity(ctx);
  if (!identity) return { key: "session", legacyKey: "session", priorCoreKey: priorCoreStorageKey("session") };

  const legacyKey = safeLegacyKey(identity.label);
  const hash = createHash("sha256")
    .update(`${SESSION_IDENTITY_VERSION}:${identity.kind}:${identity.value}`)
    .digest("hex")
    .slice(0, 16);
  return {
    key: `${SESSION_IDENTITY_VERSION}-${storageSlug(identity.label)}-${hash}`,
    legacyKey,
    priorCoreKey: priorCoreStorageKey(identity.kind === "file" ? identity.label : "session"),
  };
}

function containedChild(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== "." && !rel.startsWith("..") && !rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function legacyCandidates(root: string, identity: SessionIdentity): string[] {
  return [...new Set([
    join(root, identity.priorCoreKey),
    join(root, identity.legacyKey),
  ])].filter((candidate) => containedChild(root, candidate));
}

function assertSafeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe session storage path: ${path}`);
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error(`Unsafe session storage symlink: ${child}`);
    if (childStat.isDirectory()) assertSafeDirectory(child);
  }
}

function claimLegacyDirectory(source: string, identityKey: string): boolean {
  const claim = join(source, ".pi-rogue-v2-claim");
  try {
    writeFileSync(claim, `${identityKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (!existsSync(claim)) return false;
    const stat = lstatSync(claim);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    try {
      return readFileSync(claim, "utf8").trim() === identityKey;
    } catch {
      return false;
    }
  }
}

function copyLegacyDirectory(source: string, target: string): void {
  assertSafeDirectory(source);
  const stagingRoot = mkdtempSync(join(dirname(target), ".session-migration-"));
  const staged = join(stagingRoot, "session");
  try {
    cpSync(source, staged, { recursive: true, errorOnExist: false, force: false, dereference: false });
    assertSafeDirectory(staged);
    try {
      renameSync(staged, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function sessionScopedDir(root: string, ctx: any): string {
  mkdirSync(root, { recursive: true });
  const identity = sessionIdentity(ctx);
  const currentDir = join(root, identity.key);
  if (existsSync(currentDir)) {
    assertSafeDirectory(currentDir);
    return currentDir;
  }

  for (const candidate of legacyCandidates(root, identity)) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) break;
    assertSafeDirectory(candidate);
    if (!claimLegacyDirectory(candidate, identity.key)) break;
    copyLegacyDirectory(candidate, currentDir);
    if (existsSync(currentDir)) {
      assertSafeDirectory(currentDir);
      return currentDir;
    }
    break;
  }

  mkdirSync(currentDir, { recursive: true });
  assertSafeDirectory(currentDir);
  return currentDir;
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
  return sessionIdentity(ctx).key;
}

export function sessionDir(feature: string, ctx: any): string {
  return sessionScopedDir(featureDir(feature), ctx);
}

export function featureFile(feature: string, filename: string): string {
  return join(featureDir(feature), filename);
}

export function sessionFile(feature: string, ctx: any, filename: string): string {
  return join(sessionDir(feature, ctx), filename);
}
