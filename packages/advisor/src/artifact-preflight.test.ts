import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArtifactReferences, findMissingArtifactReferences } from "./artifact-preflight.js";

let cwd = "";
let homeArtifact = "";

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (homeArtifact) rmSync(homeArtifact, { force: true });
  cwd = "";
  homeArtifact = "";
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

  it("preserves and resolves home-relative artifact references", () => {
    cwd = mkdtempSync(join(tmpdir(), "advisor-artifact-preflight-"));
    homeArtifact = join(homedir(), `.pi-rogue-artifact-preflight-${process.pid}-${Date.now()}.json`);
    writeFileSync(homeArtifact, "{}\n");
    const homeRef = `~/${basename(homeArtifact)}`;

    expect(extractArtifactReferences(`review ${homeRef} before continuing`)).toEqual([homeRef]);
    expect(findMissingArtifactReferences(cwd, `review ${homeRef} before continuing`)).toEqual([]);
  });

  it("does not reinterpret home-relative references as root-relative missing artifacts", () => {
    const missingHomeRef = `~/.pi/agent/pi-rogue/advisor/definitely-missing-${process.pid}.json`;
    expect(extractArtifactReferences(`see ${missingHomeRef}`)).toEqual([missingHomeRef]);
    expect(findMissingArtifactReferences(process.cwd(), `see ${missingHomeRef}`)).toEqual([missingHomeRef]);
  });

  it("extracts explicitly requested bare filenames", () => {
    const refs = extractArtifactReferences("Please read `config.json` before continuing");
    expect(refs).toEqual(["config.json"]);
  });

  it("ignores prose-like bare markdown filenames that are not review docs", () => {
    const refs = extractArtifactReferences("stale `current.md` review warning was replaced after clean closeout");
    expect(refs).toEqual([]);
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
