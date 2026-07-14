import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stat: { uid: number }, path: string): void {
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`refusing artifact path not owned by current user: ${path}`);
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !parse(rel).root);
}

function assertNoSymlinkComponents(path: string): void {
  const target = resolve(path);
  const trusted = [resolve(homedir()), resolve(tmpdir()), resolve(process.cwd())]
    .filter((root) => isWithin(root, target))
    .sort((a, b) => b.length - a.length)[0];
  let current = trusted ?? parse(target).root;
  const suffix = relative(current, target);
  for (const component of suffix.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`refusing symbolic-link artifact path component: ${current}`);
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

export function ensureOwnerOnlyDirectory(path: string): string {
  assertNoSymlinkComponents(path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing symbolic-link artifact directory: ${path}`);
    if (!stat.isDirectory()) throw new Error(`artifact directory path is not a directory: ${path}`);
    assertOwned(stat, path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
    const created = lstatSync(path);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`artifact directory was replaced during creation: ${path}`);
    assertOwned(created, path);
  }
  assertNoSymlinkComponents(path);
  chmodSync(path, DIRECTORY_MODE);
  return path;
}

export function tightenOwnerOnlyFile(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing symbolic-link artifact file: ${path}`);
  if (!stat.isFile()) throw new Error(`artifact path is not a regular file: ${path}`);
  assertOwned(stat, path);
  chmodSync(path, FILE_MODE);
  return true;
}

export function secureWriteFile(path: string, data: string | Buffer, mode: "write" | "append" | "exclusive" = "write"): void {
  ensureOwnerOnlyDirectory(dirname(path));
  tightenOwnerOnlyFile(path);
  const operation = mode === "append"
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
    : mode === "exclusive"
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, operation | noFollow, FILE_MODE);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`artifact path is not a regular file: ${path}`);
    assertOwned(stat, path);
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export function tightenSqliteArtifacts(path: string): void {
  ensureOwnerOnlyDirectory(dirname(path));
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) tightenOwnerOnlyFile(candidate);
}
