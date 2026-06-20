import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArtifactReferences, findMissingArtifactReferences } from "./artifact-preflight.js";

let cwd = "";

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = "";
});

describe("artifact preflight", () => {
  it("extracts explicit absolute and relative artifact references", () => {
    const refs = extractArtifactReferences("review /tmp/issue175-review-bundle.txt, `plan.md`, and docs/fusion.md before continuing");
    expect(refs).toEqual(expect.arrayContaining(["/tmp/issue175-review-bundle.txt", "plan.md", "docs/fusion.md"]));
  });

  it("ignores diff-like path prefixes and url paths", () => {
    const refs = extractArtifactReferences("compare b/packages/advisor/src/extension.ts and packages/advisor/src/extension.ts; see https://example.com/docs/fusion.md");
    expect(refs).toEqual(["packages/advisor/src/extension.ts"]);
  });

  it("reports missing artifact references relative to the working directory", () => {
    cwd = mkdtempSync(join(tmpdir(), "advisor-artifact-preflight-"));
    const bundle = `/tmp/pi-rogue-artifact-preflight-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    writeFileSync(join(cwd, "plan.md"), "plan ok\n");

    const missing = findMissingArtifactReferences(cwd, "Please read `plan.md` and `progress.md` first.", `bundle at ${bundle}`);
    expect(missing).toEqual(expect.arrayContaining(["progress.md", bundle]));
    expect(missing).not.toContain("plan.md");
  });
});
