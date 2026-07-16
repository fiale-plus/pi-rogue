#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tarball = process.argv[2];
if (!tarball) throw new Error("usage: finalize-canonical-tarball.mjs <tarball>");
if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);

const temp = mkdtempSync(join(tmpdir(), "pi-rogue-finalize-tarball-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", temp]);
  const packageDir = join(temp, "package");
  const packageJson = join(packageDir, "package.json");
  const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
  const internal = new Set(pkg.bundledDependencies ?? pkg.bundleDependencies ?? []);
  if (internal.size === 0) throw new Error("canonical tarball has no bundled internal packages");

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!pkg[field]) continue;
    for (const name of internal) delete pkg[field][name];
    if (Object.keys(pkg[field]).length === 0) delete pkg[field];
  }
  writeFileSync(packageJson, `${JSON.stringify(pkg, null, 2)}\n`);

  const output = `${tarball}.tmp`;
  execFileSync("tar", ["-czf", output, "-C", temp, "package"]);
  renameSync(output, tarball);
  console.log(`Finalized canonical tarball metadata: removed ${internal.size} internal dependency declaration(s).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
