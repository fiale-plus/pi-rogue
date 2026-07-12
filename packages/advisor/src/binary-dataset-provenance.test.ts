import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { main as buildDataset } from "../../../scripts/build-binary-gate-dataset.js";
import { assertDatasetGovernance, manifestPathFor, readBinaryDatasetManifest } from "../../../scripts/binary-dataset-manifest.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "binary-provenance-"));
  dirs.push(dir);
  const gold = join(dir, "gold.jsonl");
  const history = join(dir, "history.jsonl");
  const output = join(dir, "binary.jsonl");
  writeFileSync(gold, "", "utf8");
  writeFileSync(history, "", "utf8");
  const args = ["--gold-input", gold, "--claude-history", history, "--pi-sessions", join(dir, "missing-pi"), "--claude-projects", join(dir, "missing-claude"), "--output", output];
  return { gold, history, output, args };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("binary dataset provenance", () => {
  it("fails closed with zero reviewed rows", () => {
    const f = fixture();
    expect(() => buildDataset([...f.args, "--min-reviewed", "1"])).toThrow(/minimum not met/);
  });

  it.each(["0", "-1", "nope"])("rejects invalid reviewed minimum %s", (minimum) => {
    const f = fixture();
    expect(() => buildDataset([...f.args, "--min-reviewed", minimum])).toThrow(/positive integer/);
  });

  it("fails closed below the configured reviewed minimum", () => {
    const f = fixture();
    writeFileSync(f.gold, `${JSON.stringify({ text: "implement the endpoint", label: "implementation" })}\n`, "utf8");
    expect(() => buildDataset([...f.args, "--min-reviewed", "2"])).toThrow(/1\/2/);
  });

  it("emits reviewed, heuristic, source, conflict, and exclusion counts", () => {
    const f = fixture();
    writeFileSync(f.gold, [
      { text: "implement the endpoint", label: "implementation" },
      { text: "debug the security failure", label: "debugging" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    writeFileSync(f.history, `${JSON.stringify({ display: "research a deployment strategy" })}\n`, "utf8");

    buildDataset([...f.args, "--min-reviewed", "2"]);
    const manifest = readBinaryDatasetManifest(f.output);
    expect(manifest.mode).toBe("reviewed-training");
    expect(manifest.promotable).toBe(true);
    expect(manifest.counts).toMatchObject({ reviewed: 2, heuristic: 1, conflicts: 0, sources: { gold: 2, claude_history: 1 } });
    expect(manifest.counts.exclusions).toEqual({});

    const model = join(dirname(f.output), "mixed-model.json");
    const report = join(dirname(f.output), "mixed-report.json");
    writeFileSync(model, JSON.stringify({ kind: "binary-logreg-v2", labels: ["continue", "escalate"], features: [], idf: [], bias: [0, 0], weights: [[], []], thresholds: { default: 0.5 } }), "utf8");
    execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/eval-binary-gate-file.ts"), "--input", f.output, "--model", model, "--report", report]);
    expect(JSON.parse(readFileSync(report, "utf8")).rows).toBe(2);
    const candidateReport = join(dirname(f.output), "mixed-candidate-report.json");
    execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/eval-binary-gate-candidate-matrix.ts"), "--input", f.output, "--report", candidateReport]);
    expect(JSON.parse(readFileSync(candidateReport, "utf8")).goldSplit.test).toBe(2);
  });

  it("rejects a non-positive reviewed minimum in a downstream manifest", () => {
    const f = fixture();
    writeFileSync(f.gold, `${JSON.stringify({ text: "implement reviewed work", label: "implementation" })}\n`, "utf8");
    buildDataset([...f.args, "--min-reviewed", "1"]);
    const manifestPath = manifestPathFor(f.output);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.minimumReviewed = 0;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(() => assertDatasetGovernance(f.output, false)).toThrow(/reviewed minimum is invalid/);
  });

  it("rejects manifest provenance counts that do not match dataset rows", () => {
    const f = fixture();
    writeFileSync(f.gold, `${JSON.stringify({ text: "implement reviewed work", label: "implementation" })}\n`, "utf8");
    buildDataset([...f.args, "--min-reviewed", "1"]);
    const manifestPath = manifestPathFor(f.output);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.counts.reviewed = 2;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(() => readBinaryDatasetManifest(f.output)).toThrow(/provenance counts do not match/);
  });

  it("propagates provenance through trajectory enrichment into training", () => {
    const f = fixture();
    const gold = Array.from({ length: 20 }, (_, index) => ({
      text: `${index % 2 ? "debug failing test" : "implement routine change"} ${index}`,
      label: index % 2 ? "debugging" : "implementation",
    }));
    writeFileSync(f.gold, gold.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    buildDataset([...f.args, "--min-reviewed", "10"]);
    const trajectory = join(dirname(f.output), "trajectory.jsonl");
    const model = join(dirname(f.output), "model.json");
    const report = join(dirname(f.output), "report.json");
    execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/build-binary-gate-trajectory-dataset.ts"), "--labels", f.output, "--input", join(dirname(f.output), "missing-sessions"), "--no-claude-proxy", "--output", trajectory, "--report", join(dirname(f.output), "trajectory-report.json")]);
    expect(readBinaryDatasetManifest(trajectory).promotable).toBe(true);
    execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/train-binary-gate.ts"), "--input", trajectory, "--model", model, "--report", report, "--epochs", "1", "--min-df", "1", "--min-guard-support", "1", "--allow-weak-label-research"]);
    expect(JSON.parse(readFileSync(model, "utf8")).config.weakLabelResearch).toBe(false);
    expect(JSON.parse(readFileSync(report, "utf8")).provenance.promotable).toBe(true);
  }, 20_000);

  it("allows explicit weak-label research but blocks promotion/evaluation by default", () => {
    const f = fixture();
    writeFileSync(f.history, `${JSON.stringify({ display: "debug a failing production test" })}\n`, "utf8");
    buildDataset([...f.args, "--min-reviewed", "2", "--weak-label-research"]);

    const manifest = JSON.parse(readFileSync(manifestPathFor(f.output), "utf8"));
    expect(manifest).toMatchObject({ mode: "weak-label-research", promotable: false, counts: { reviewed: 0, heuristic: 1 } });
    expect(() => assertDatasetGovernance(f.output, false)).toThrow(/weak-label research only/);
    expect(assertDatasetGovernance(f.output, true).promotable).toBe(false);

    const model = join(dirname(f.output), "weak-eval-model.json");
    const report = join(dirname(f.output), "weak-eval-report.json");
    writeFileSync(model, JSON.stringify({ kind: "binary-logreg-v2", labels: ["continue", "escalate"], features: [], idf: [], bias: [0, 0], weights: [[], []], thresholds: { default: 0.5 } }), "utf8");
    const evalArgs = ["--import", "tsx", join(process.cwd(), "scripts/eval-binary-gate-file.ts"), "--input", f.output, "--model", model, "--report", report];
    expect(() => execFileSync(process.execPath, evalArgs)).toThrow();
    expect(() => execFileSync(process.execPath, [...evalArgs, "--allow-weak-label-research", "false"])).toThrow();
    expect(() => execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/eval-binary-gate-candidate-matrix.ts"), "--input", f.output, "--report", join(dirname(f.output), "candidate-report.json")])).toThrow();
    expect(() => execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/compare-binary-gate-v1-v2.ts"), f.output])).toThrow();
    execFileSync(process.execPath, [...evalArgs, "--allow-weak-label-research"]);
    expect(JSON.parse(readFileSync(report, "utf8")).provenance.promotable).toBe(false);
  });
});
