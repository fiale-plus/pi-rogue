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
    const refs = extractArtifactReferences("compare b/packages/advisor/src/extension.ts. Inspect packages/advisor/src/extension.ts; see https://example.com/docs/fusion.md");
    expect(refs).toEqual(["packages/advisor/src/extension.ts"]);
  });

  it("ignores scoped npm package paths without extracting an unscoped suffix", () => {
    const text = "Pi docs: @earendil-works/pi-coding-agent/docs/settings.md and `@earendil-works/pi-coding-agent/README.md`";
    expect(extractArtifactReferences(text)).toEqual([]);
    expect(findMissingArtifactReferences(process.cwd(), text)).toEqual([]);
  });

  it("ignores passive ambiguous bare paths", () => {
    const text = "Read docs/setup.md before continuing. The package file earendil-works/pi-coding-agent/README.md is installed globally; source summary mentions packages/core/src/index.ts";
    expect(extractArtifactReferences(text)).toEqual(["docs/setup.md"]);
  });

  it("does not extend an imperative across passive prose", () => {
    const text = "Read docs/setup.md before continuing, package documentation mentions earendil-works/pi-coding-agent/README.md. The review notes package documentation at packages/core/progress.md";
    expect(extractArtifactReferences(text)).toEqual(["docs/setup.md"]);
  });

  it("recognizes directly introduced imperatives regardless of clause prefix", () => {
    expect(extractArtifactReferences("Before continuing, read docs/setup.md")).toEqual(["docs/setup.md"]);
    expect(extractArtifactReferences("Can you check packages/core/src/index.ts?")).toEqual(["packages/core/src/index.ts"]);
    expect(extractArtifactReferences("Review changes in packages/core/src/index.ts")).toEqual(["packages/core/src/index.ts"]);
    expect(extractArtifactReferences("Read docs/a.md as well as packages/core/b.ts")).toEqual(["docs/a.md", "packages/core/b.ts"]);
  });

  it("extracts required paths from inline and multiline imperative lists", () => {
    expect(extractArtifactReferences("Read both docs/a.md and packages/core/b.ts before review")).toEqual(["docs/a.md", "packages/core/b.ts"]);

    const text = "Read the following:\n1) docs/setup.md\n2. packages/core/src/index.ts\n- Read docs/extra.md";
    expect(extractArtifactReferences(text)).toEqual(["docs/setup.md", "packages/core/src/index.ts", "docs/extra.md"]);
  });

  it("extracts inline and multiline required artifact labels", () => {
    expect(extractArtifactReferences("Required artifacts: docs/plan.md and packages/core/progress.md")).toEqual(["docs/plan.md", "packages/core/progress.md"]);
    expect(extractArtifactReferences("Required files:\n- docs/setup.md\n  setup context\n\n- packages/core/src/index.ts")).toEqual(["docs/setup.md", "packages/core/src/index.ts"]);
  });

  it("does not treat passive review headings as imperative lists", () => {
    const text = "Review notes:\n- package documentation: earendil-works/pi-coding-agent/README.md\n- source summary: packages/core/progress.md";
    expect(extractArtifactReferences(text)).toEqual([]);
  });

  it("checks required and explicitly relative project paths", () => {
    const refs = extractArtifactReferences(
      "Read packages/core/src/input.ts before review. [Read from: docs/context.json] Passive explicit path: ./packages/core/src/index.ts",
    );
    expect(refs).toEqual(expect.arrayContaining(["packages/core/src/input.ts", "docs/context.json", "./packages/core/src/index.ts"]));
  });

  it("ignores paths containing a node_modules segment", () => {
    const text = "Package docs: node_modules/ripgrep/README.md, ./node_modules/pkg/docs/settings.json, and /tmp/node_modules/pkg/docs/config.yaml";
    expect(extractArtifactReferences(text)).toEqual([]);
    expect(findMissingArtifactReferences(process.cwd(), text)).toEqual([]);
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
    const refs = extractArtifactReferences("Please read `config.json` before continuing; bundle: `summary.json`");
    expect(refs).toEqual(["config.json", "summary.json"]);
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
