import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractReviewArtifactHints, findMissingReviewArtifacts } from "./review-preflight.js";

let cwd = "";

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = "";
});

describe("review preflight", () => {
  it("extracts explicit plan and progress hints", () => {
    const refs = extractReviewArtifactHints("review plan.md, ./progress.md, docs/review/progress.md, and /var/folders/pi-review-summary.json before continuing");
    expect(refs).toEqual(expect.arrayContaining(["plan.md", "./progress.md", "docs/review/progress.md", "/var/folders/pi-review-summary.json"]));
  });

  it("does not treat URL paths as local review artifacts", () => {
    const refs = extractReviewArtifactHints("see https://example.com/docs/progress.md and then read progress.md");
    expect(refs).toEqual(["progress.md"]);
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
