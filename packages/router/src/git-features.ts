import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { hashText } from "./hash.js";
import type { DiffStats } from "./types.js";

export const EMPTY_DIFF_STATS: DiffStats = {
  filesChanged: 0,
  linesAdded: 0,
  linesDeleted: 0,
  totalLines: 0,
  fileHashes: [],
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd: resolve(cwd), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function parseNumstat(output: string, excludeFiles = new Set<string>()): Pick<DiffStats, "filesChanged" | "linesAdded" | "linesDeleted" | "totalLines" | "fileHashes"> {
  let rows = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  const fileHashes = new Set<string>();

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...fileParts] = line.split("\t");
    const file = fileParts.join("\t").trim();
    if (file && excludeFiles.has(file)) continue;
    rows++;
    if (file) fileHashes.add(hashText(file));
    const add = Number(added);
    const del = Number(deleted);
    if (Number.isFinite(add)) linesAdded += add;
    if (Number.isFinite(del)) linesDeleted += del;
  }

  return { filesChanged: fileHashes.size || rows, linesAdded, linesDeleted, totalLines: linesAdded + linesDeleted, fileHashes: [...fileHashes].sort() };
}

function untrackedFiles(cwd: string, excludeFiles = new Set<string>()): { hashes: string[]; linesAdded: number } {
  try {
    let linesAdded = 0;
    const hashes: string[] = [];
    for (const raw of git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
      const file = raw.trim();
      if (!file || excludeFiles.has(file)) continue;
      hashes.push(hashText(file));
      try {
        const path = resolve(cwd, file);
        const stat = statSync(path);
        if (stat.size <= 1_000_000) {
          const text = readFileSync(path, "utf8");
          linesAdded += text.length === 0 ? 0 : text.split(/\r?\n/).filter((line, index, arr) => line.length > 0 || index < arr.length - 1).length;
        }
      } catch {
        // Large, binary, or unreadable untracked files still count as changed files; line count remains unknown/zero.
      }
    }
    return { hashes, linesAdded };
  } catch {
    return { hashes: [], linesAdded: 0 };
  }
}

function excludeFilesFromPaths(root: string, paths: string[] | undefined): Set<string> {
  const files = new Set<string>();
  const realRoot = realpathSync(root);
  for (const path of paths ?? []) {
    const absolute = isAbsolute(path) ? path : resolve(root, path);
    let rel = relative(root, absolute);
    try {
      rel = relative(realRoot, realpathSync(absolute));
    } catch {
      // Output paths may not exist yet; fall back to lexical repo-relative path.
    }
    if (rel && !rel.startsWith("..")) files.add(rel);
  }
  return files;
}

export function readGitDiffStats(cwd?: string, options: { excludePaths?: string[] } = {}): DiffStats {
  if (!cwd) return EMPTY_DIFF_STATS;
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim() || cwd;
    const excludeFiles = excludeFilesFromPaths(root, options.excludePaths);
    const untracked = untrackedFiles(root, excludeFiles);
    let parsed: Pick<DiffStats, "filesChanged" | "linesAdded" | "linesDeleted" | "totalLines" | "fileHashes"> = EMPTY_DIFF_STATS;
    let shortStat = "";
    try {
      parsed = parseNumstat(git(root, ["diff", "--numstat", "HEAD"]), excludeFiles);
      shortStat = git(root, ["diff", "--shortstat", "HEAD"]).trim();
    } catch {
      // Repositories without an initial commit have no HEAD; include staged files plus untracked counts.
      try {
        const cachedNumstat = git(root, ["diff", "--cached", "--numstat"]);
        const worktreeNumstat = git(root, ["diff", "--numstat"]);
        parsed = parseNumstat(`${cachedNumstat}\n${worktreeNumstat}`, excludeFiles);
        shortStat = `${git(root, ["diff", "--cached", "--shortstat"]).trim()} ${git(root, ["diff", "--shortstat"]).trim()}`.trim();
      } catch {
        // Still report untracked-file counts/hashes below.
      }
    }
    const fileHashes = [...new Set([...parsed.fileHashes, ...untracked.hashes])].sort();
    const filesChanged = Math.max(fileHashes.length, parsed.filesChanged + untracked.hashes.length);
    const linesAdded = parsed.linesAdded + untracked.linesAdded;
    const totalLines = linesAdded + parsed.linesDeleted;
    if (filesChanged === 0) return EMPTY_DIFF_STATS;
    const shortStatHash = shortStat || untracked.hashes.length ? hashText(shortStat, `untracked:${untracked.hashes.length}:${untracked.linesAdded}`) : undefined;
    return { ...parsed, filesChanged, linesAdded, totalLines, fileHashes, shortStatHash };
  } catch {
    return EMPTY_DIFF_STATS;
  }
}

export function diffChurnScore(stats: DiffStats): number {
  if (stats.totalLines <= 0) return 0;
  return Math.max(0, Math.min(1, stats.totalLines / 1200));
}
