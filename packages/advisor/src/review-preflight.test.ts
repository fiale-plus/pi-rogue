import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractReviewArtifactHints, findMissingReviewArtifacts } from "./review-preflight.js";

let cwd = "";
let homeArtifact = "";

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (homeArtifact) rmSync(homeArtifact, { force: true });
  cwd = "";
  homeArtifact = "";
});

describe("review preflight", () => {
  it("extracts explicit plan and progress hints", () => {
    const refs = extractReviewArtifactHints("review plan.md, ./progress.md, docs/review/progress.md, and /var/folders/pi-review-summary.json before continuing");
    expect(refs).toEqual(expect.arrayContaining(["plan.md", "./progress.md", "docs/review/progress.md", "/var/folders/pi-review-summary.json"]));
  });

  it("does not treat URL paths or relative-path suffixes as local review artifacts", () => {
    const refs = extractReviewArtifactHints("see https://example.com/docs/progress.md, inspect packages/context-broker/src/extension.ts, and then read progress.md");
    expect(refs).toEqual(["progress.md"]);
  });

  it("preserves and resolves home-relative review artifact hints", () => {
    cwd = mkdtempSync(join(tmpdir(), "advisor-review-preflight-"));
    homeArtifact = join(homedir(), `.pi-rogue-review-preflight-${process.pid}-${Date.now()}.json`);
    writeFileSync(homeArtifact, "{}\n");
    const homeRef = `~/${basename(homeArtifact)}`;

    expect(extractReviewArtifactHints(`review ${homeRef} before continuing`)).toEqual([homeRef]);
    expect(findMissingReviewArtifacts(cwd, `review ${homeRef} before continuing`)).toEqual([]);
  });

  it("does not reinterpret home-relative hints as root-relative missing artifacts", () => {
    const missingHomeRef = `~/.pi/agent/pi-rogue/advisor/definitely-missing-${process.pid}.json`;
    expect(extractReviewArtifactHints(`see ${missingHomeRef}`)).toEqual([missingHomeRef]);
    expect(findMissingReviewArtifacts(process.cwd(), `see ${missingHomeRef}`)).toEqual([missingHomeRef]);
  });

  it("reports missing review artifacts relative to the working directory", () => {
    cwd = mkdtempSync(join(tmpdir(), "advisor-review-preflight-"));
    const bundle = `/tmp/pi-rogue-review-preflight-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    writeFileSync(join(cwd, "plan.md"), "plan ok\n");

    const missing = findMissingReviewArtifacts(cwd, "Please read plan.md and progress.md first.", `bundle at ${bundle}`);
    expect(missing).toEqual(expect.arrayContaining(["progress.md", bundle]));
    expect(missing).not.toContain("plan.md");
  });
});
