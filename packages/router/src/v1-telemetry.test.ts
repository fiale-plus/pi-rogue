import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebuildCheckpointsFromSession, writeSessionCheckpointsJsonl } from "./checkpoints.js";
import { buildTrainingRows, writeTrainingRows } from "./dataset.js";
import { decideRoute } from "./decision.js";
import { buildRouteEvent } from "./ledger.js";
import { readGitDiffStats } from "./git-features.js";
import { generateTeacherPromptRequests } from "./learning.js";
import { buildUnknownOutcome, inferOutcomes, writeInferredOutcomes } from "./outcomes.js";
import { buildSubagentLedgerEvent, recommendSubagentDecision } from "./subagents.js";
import type { RouterCheckpoint } from "./types.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-router-v1-")), name);
}

function writeFixture(lines: Array<Record<string, unknown>>): string {
  const path = tempFile("session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function checkpoint(overrides: Partial<Omit<RouterCheckpoint, "features" | "recent">> & { features?: Partial<RouterCheckpoint["features"]> } = {}): RouterCheckpoint {
  const base: RouterCheckpoint = {
    schema: "pi-router.checkpoint.v1",
    sessionId: "session-1",
    checkpointId: "session-1:event-10",
    createdAt: "2026-06-12T00:00:00.000Z",
    rawSessionRef: { schema: "pi-router.raw-session-ref.v1", path: "/tmp/session.jsonl", fromEvent: 1, toEvent: 10, fromByte: 100, toByte: 200, contentHash: "hash-only" },
    harness: "pi",
    phase: "debug",
    activeModel: "qwen3.6-35b-a3b-128k",
    provider: "local",
    features: {
      turnIndex: 10,
      sameCommandRepeatedCount: 1,
      sameErrorRepeatedCount: 2,
      errorChanged: false,
      testsImproved: null,
      filesTouched: 1,
      diffLines: 40,
      diffFilesChanged: 2,
      diffLinesAdded: 25,
      diffLinesDeleted: 15,
      diffChurnScore: 0.033,
      toolThrashScore: 0.1,
      goalDriftScore: 0,
      loopScore: 0.52,
      progressScore: 0.48,
      verifierUsed: false,
      noVerifierUsed: true,
      toolCallsLast10Turns: 4,
      contextTokensApprox: 1200,
      gitDirty: null,
    },
    recent: { lastErrorHash: "error", lastErrorFingerprintHash: "fingerprint", touchedFileHashes: ["file"], diffFileHashes: ["diff-file"] },
    sourceEvent: { index: 10, byteStart: 100, byteEnd: 200, type: "message", role: "toolResult" },
  };
  return { ...base, ...overrides, features: { ...base.features, ...(overrides.features ?? {}) } };
}

describe("router v1 outcome and feature telemetry", () => {
  it("normalizes noisy repeated errors into stable fingerprints", () => {
    const sessionPath = writeFixture([
      { type: "session", id: "s", cwd: "/repo" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "debug failing test" }] } },
      { type: "message", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "FAIL /tmp/a/foo.test.ts:10:2\nError: boom at 2026-06-12T00:00:00Z" }] } },
      { type: "message", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "FAIL /var/b/foo.test.ts:99:8\nError: boom at 2026-06-13T00:00:00Z" }] } },
    ]);

    const last = rebuildCheckpointsFromSession(sessionPath).at(-1);

    expect(last?.features.sameErrorRepeatedCount).toBe(2);
    expect(last?.features.errorChanged).toBe(false);
    expect(last?.recent.lastErrorFingerprintHash).toBeTruthy();
  });

  it("reads staged and untracked git diff counts without raw paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-router-git-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "router@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "router"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "a\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "a\nb\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    writeFileSync(join(repo, "new-file.txt"), "secret-ish content\n");

    const stats = readGitDiffStats(repo);
    execFileSync("mkdir", ["-p", ".pi/router/sessions/other"], { cwd: repo });
    writeFileSync(join(repo, ".pi/router/sessions/other/events.jsonl"), "{}\n");
    const excluded = readGitDiffStats(repo, { excludePaths: [join(repo, "new-file.txt")] });
    const excludedRouterDir = readGitDiffStats(repo, { excludePaths: [join(repo, ".pi/router")] });

    expect(stats.filesChanged).toBeGreaterThanOrEqual(2);
    expect(stats.linesAdded).toBeGreaterThanOrEqual(1);
    expect(stats.fileHashes).toHaveLength(stats.filesChanged);
    expect(JSON.stringify(stats)).not.toContain("tracked.txt");
    expect(JSON.stringify(stats)).not.toContain("new-file.txt");
    expect(excluded.filesChanged).toBe(2);
    expect(excludedRouterDir.filesChanged).toBe(2);
  });

  it("reads untracked files from repo root when launched in a subdirectory", () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-router-git-subdir-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "router@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "router"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "a\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    execFileSync("mkdir", ["-p", "nested"], { cwd: repo });
    writeFileSync(join(repo, "root-new.txt"), "one\n");

    expect(readGitDiffStats(join(repo, "nested")).filesChanged).toBe(1);
  });

  it("reads untracked diff counts in repositories without HEAD", () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-router-git-no-head-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "new-file.txt"), "one\ntwo\n");
    execFileSync("git", ["add", "new-file.txt"], { cwd: repo });
    writeFileSync(join(repo, "new-file.txt"), "one\ntwo\nthree\n");

    const stats = readGitDiffStats(repo);

    expect(stats.filesChanged).toBe(1);
    expect(stats.linesAdded).toBe(3);
  });

  it("infers conservative outcome skeletons linked to route events", () => {
    const item = checkpoint();
    const event = buildRouteEvent(item, decideRoute(item), "2026-06-12T00:00:00.000Z");
    const outcome = buildUnknownOutcome(event, item, "2026-06-12T00:00:01.000Z");

    expect(outcome).toMatchObject({
      schema: "pi-router.outcome.v1",
      sessionId: item.sessionId,
      checkpointId: item.checkpointId,
      routeEventId: event.eventId,
      taskStatus: "unknown",
      finalFilesTouched: 2,
      finalDiffLines: 40,
      reworkTurns: 1,
      evidence: { source: "inferred" },
    });
    expect(buildUnknownOutcome(event, checkpoint({ features: { diffFilesChanged: 0, filesTouched: 1 } }))).toMatchObject({ finalFilesTouched: 1 });
    expect(JSON.stringify(outcome)).not.toContain("Error: boom");
  });

  it("writes inferred outcomes from checkpoint and route-event files", () => {
    const item = checkpoint();
    const checkpointPath = tempFile("checkpoints.jsonl");
    const eventsPath = tempFile("events.jsonl");
    const outputPath = tempFile("outcomes.jsonl");
    writeFileSync(checkpointPath, `${JSON.stringify(item)}\n`);
    writeFileSync(eventsPath, `${JSON.stringify(buildRouteEvent(item, decideRoute(item)))}\n`);

    const summary = writeInferredOutcomes({ checkpointPath, eventsPath, outputPath });

    expect(summary.outcomes).toBe(1);
    expect(readFileSync(outputPath, "utf8")).toContain("pi-router.outcome.v1");
    expect(() => writeInferredOutcomes({ checkpointPath, eventsPath: join(tmpdir(), "missing-router-events.jsonl"), outputPath: tempFile("bad.jsonl") })).toThrow(/required route events file not found/);
  });

  it("rejects workspace diff annotation for multi-session rebuilds", async () => {
    await expect(writeSessionCheckpointsJsonl([tempFile("one.jsonl"), tempFile("two.jsonl")], tempFile("out.jsonl"), { workspaceDiff: true }))
      .rejects.toThrow(/exactly one current session/);
  });
});

describe("router v1 teacher requests and trainable gate dataset", () => {
  it("generates explicit teacher prompt requests without raw transcript content", () => {
    const item = checkpoint();
    const requests = generateTeacherPromptRequests([item], "openai-codex/gpt-5.5");

    expect(requests[0]).toMatchObject({
      schema: "pi-router.teacher-prompt.v1",
      teacher: "openai-codex/gpt-5.5",
      checkpointId: item.checkpointId,
    });
    expect(requests[0].allowedActions).toContain("spawn_subagent");
    expect(JSON.stringify(requests[0])).not.toContain("npm test");
  });

  it("exports binary gate rows and excludes local-rule labels as ground truth by default", () => {
    const item = checkpoint();
    const event = buildRouteEvent(item, decideRoute(item));
    const outcome = inferOutcomes([event], [item])[0];
    const localRuleLabel = {
      schema: "pi-router.teacher-label.v1" as const,
      labelId: "label-1",
      generatedAt: "2026-06-12T00:00:00.000Z",
      teacher: "local-rule",
      checkpointId: item.checkpointId,
      sessionId: item.sessionId,
      rawSessionRef: item.rawSessionRef,
      suggestedAction: "run_verifier" as const,
      confidence: 0.8,
      rationale: "local rule",
      source: "local-rule" as const,
    };

    const oldCheckpoint = { ...item, features: { ...item.features, diffFilesChanged: undefined as unknown as number, diffChurnScore: undefined as unknown as number } };
    const oldRows = buildTrainingRows({ checkpoints: [oldCheckpoint] });
    expect(oldRows[0].features).toMatchObject({ diffFilesChanged: 0, diffChurnScore: 0 });

    const rows = buildTrainingRows({ checkpoints: [item], routeEvents: [event], outcomes: [outcome], labels: [localRuleLabel] });

    expect(rows[0].labels.binaryGate).toBe("unknown");
    expect(rows[0].provenance.excludedLocalRuleAsTruth).toBe(true);
    expect(rows[0].provenance.localRuleAction).toBe(decideRoute(item).action);

    const routeOnlyOutcome = { ...outcome, checkpointId: undefined, taskStatus: "partial" as const };
    const rowsFromRouteEventOutcome = buildTrainingRows({ checkpoints: [item], routeEvents: [event], outcomes: [routeOnlyOutcome] });
    expect(rowsFromRouteEventOutcome[0].outcome.taskStatus).toBe("partial");

    const includedRows = buildTrainingRows({ checkpoints: [item], labels: [localRuleLabel], includeLocalRuleLabels: true });
    expect(includedRows[0].labels).toMatchObject({ binaryGate: "intervene", source: "local-rule" });
  });

  it("writes labeled dataset rows when teacher-output labels are provided", () => {
    const item = checkpoint();
    const checkpointPath = tempFile("checkpoints.jsonl");
    const labelsPath = tempFile("labels.jsonl");
    const outputPath = tempFile("training.jsonl");
    writeFileSync(checkpointPath, `${JSON.stringify(item)}\n`);
    writeFileSync(labelsPath, `${JSON.stringify({
      schema: "pi-router.teacher-label.v1",
      labelId: "label-2",
      generatedAt: "2026-06-12T00:00:00.000Z",
      teacher: "openai-codex/gpt-5.5",
      checkpointId: item.checkpointId,
      sessionId: item.sessionId,
      rawSessionRef: item.rawSessionRef,
      suggestedAction: "run_verifier",
      confidence: 0.81,
      rationale: "needs verifier",
      source: "teacher-output",
    })}\n`);

    const summary = writeTrainingRows({ checkpointPath, labelsPath, outputPath });

    expect(summary).toMatchObject({ rows: 1, labeledRows: 1 });
    expect(readFileSync(outputPath, "utf8")).toContain("pi-router.training-row.v1");
    expect(() => writeTrainingRows({ checkpointPath, outcomesPath: join(tmpdir(), "missing-outcomes.jsonl"), outputPath: tempFile("bad-training.jsonl") })).toThrow(/outcomes file not found/);
    expect(() => writeTrainingRows({ checkpointPath, eventsPath: join(tmpdir(), "missing-events.jsonl"), outputPath: tempFile("bad-events-training.jsonl") })).toThrow(/route events file not found/);
  });
});

describe("router v1 subagent-aware observation telemetry", () => {
  it("recommends observe-only subagent decisions with evidence-summary contracts", () => {
    const decision = recommendSubagentDecision(checkpoint(), { worker: "qwen", smart: "gpt-5.5" });

    expect(decision).toMatchObject({
      schema: "pi-router.subagent-decision.v1",
      action: "spawn_subagent",
      subagentRole: "debug_diagnose",
      targetModel: "gpt-5.5",
      toolPolicy: "read_only",
      returnContract: "evidence_summary_v1",
    });
  });

  it("builds parent-child subagent ledger events", () => {
    const event = buildSubagentLedgerEvent({
      parentSessionId: "parent",
      childSessionId: "child",
      parentCheckpointId: "parent:event-1",
      subagentRole: "review",
      model: "openai-codex/gpt-5.5",
      toolPolicy: "read_only",
      contextPolicy: "diff_only",
      inputSummaryHash: "input-hash",
      outputSummaryHash: "output-hash",
      acceptedIntoParent: null,
      useful: null,
      causedRework: null,
      returnContract: "evidence_summary_v1",
      recordedAt: "2026-06-12T00:00:00.000Z",
    });

    expect(event).toMatchObject({
      schema: "pi-router.subagent-ledger-event.v1",
      parentSessionId: "parent",
      childSessionId: "child",
      acceptedIntoParent: null,
      useful: null,
      causedRework: null,
    });
    expect(event.eventId).toBeTruthy();
  });
});
