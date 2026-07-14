#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "packages", "bundle", "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const version = pkg.version;
const lockedVersion = lock.packages?.["packages/bundle"]?.version;
if (lockedVersion !== version) throw new Error(`package-lock canonical version ${JSON.stringify(lockedVersion)} must match packages/bundle/package.json ${version}`);
const expectedTag = `pi-rogue-${version}`;
const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
if (tag !== expectedTag) throw new Error(`release tag ${JSON.stringify(tag)} must exactly match committed canonical version ${expectedTag}`);

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasChangelog = new RegExp(`^## ${escapedVersion}(?:\\s|$)`, "m").test(changelog);
let releaseBody = "";
if (process.env.GITHUB_EVENT_PATH) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  releaseBody = typeof event.release?.body === "string" ? event.release.body : "";
}
const hasReleaseNotes = ["Summary", "Changes", "Validation"].every((heading) => new RegExp(`^## ${heading}\\s*$`, "m").test(releaseBody));
if (!hasChangelog && !hasReleaseNotes) {
  throw new Error(`release ${version} requires either a CHANGELOG.md entry or GitHub release notes with Summary, Changes, and Validation sections`);
}
console.log(`release policy passed: committed version ${version} matches ${tag}; ${hasChangelog ? "changelog" : "release notes"} provisioned`);
