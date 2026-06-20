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
  it("extracts file-like review artifact hints", () => {
    const hints = extractReviewArtifactHints("review /tmp/issue175-review-bundle.txt, plan.md and progress.md before continuing");
    expect(hints).toEqual(expect.arrayContaining(["/tmp/issue175-review-bundle.txt", "plan.md", "progress.md"]));
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
