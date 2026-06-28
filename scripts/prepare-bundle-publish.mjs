#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const bundleDir = resolve(process.argv[2] || process.cwd());
const pkgPath = join(bundleDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];

if (!Array.isArray(bundled) || bundled.length === 0) {
  throw new Error("bundle package has no bundledDependencies");
}

const internal = new Set(bundled);
const aliasSpec = `npm:${pkg.name}@${pkg.version}`;
const deps = { ...(pkg.dependencies || {}) };
for (const name of bundled) {
  const leafPkgPath = join(bundleDir, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(leafPkgPath)) {
    throw new Error(`bundled dependency '${name}' is missing at ${leafPkgPath}`);
  }
  deps[name] = aliasSpec;

  const leaf = JSON.parse(readFileSync(leafPkgPath, "utf8"));
  leaf["x-pi-rogue-internal-name"] = leaf["x-pi-rogue-internal-name"] || leaf.name || name;
  leaf.name = pkg.name;
  leaf.version = pkg.version;
  delete leaf.private;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!leaf[field]) continue;
    for (const dep of Object.keys(leaf[field])) {
      if (internal.has(dep)) leaf[field][dep] = aliasSpec;
    }
  }
  writeFileSync(leafPkgPath, `${JSON.stringify(leaf, null, 2)}\n`);
}

pkg.dependencies = deps;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Prepared ${pkg.name}@${pkg.version} with ${bundled.length} bundled internal package(s).`);
