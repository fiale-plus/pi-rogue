import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTeacherDecision, runTeacherLabeling, teacherPromptText, type TeacherModelExecutor } from "./teacher-runner.js";
import type { TeacherPromptRequest } from "./learning.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-router-teacher-")), name);
}

function request(overrides: Partial<TeacherPromptRequest> = {}): TeacherPromptRequest {
  return {
    schema: "pi-router.teacher-prompt.v1",
    requestId: "request-1",
    teacher: "openai-codex/gpt-5.5",
    checkpointId: "session-1:event-1",
    sessionId: "session-1",
    rawSessionRef: { schema: "pi-router.raw-session-ref.v1", path: "/tmp/session.jsonl", fromEvent: 1, toEvent: 2, fromByte: 10, toByte: 20, contentHash: "hash-only" },
    allowedActions: ["continue_current", "run_verifier", "escalate_debug_diagnosis"],
    instruction: "Return one decision.",
    features: {
      phase: "debug",
      activeModel: "qwen3.6-35b-a3b-128k",
      provider: "local",
      loopScore: 0.7,
      progressScore: 0.3,
      sameCommandRepeatedCount: 1,
      sameErrorRepeatedCount: 2,
      verifierUsed: false,
      noVerifierUsed: true,
      diffLines: 12,
      diffFilesChanged: 2,
    },
    ...overrides,
  };
}

function decisionJson(action = "run_verifier") {
  return JSON.stringify({
    schema: "pi-router.decision.v1",
    checkpointId: "session-1:event-1",
    action,
    adviceShape: "none",
    contextPolicy: "minimal",
    confidence: 0.82,
    reason: "teacher says verifier should run before more edits",
    policyVersion: "teacher/openai-codex/gpt-5.5",
  });
}

describe("router teacher label runner", () => {
  it("builds explicit teacher prompts with only the bounded raw session span", () => {
    const sessionPath = tempFile("session.jsonl");
    writeFileSync(sessionPath, "0123456789bounded-span-secret-tail");
    const prompt = teacherPromptText(request({ rawSessionRef: { schema: "pi-router.raw-session-ref.v1", path: sessionPath, fromEvent: 1, toEvent: 2, fromByte: 10, toByte: 22, contentHash: "hash-only" } }));

    expect(prompt).toContain("Return exactly one JSON object");
    expect(prompt).toContain("run_verifier");
    expect(prompt).toContain("rawSessionRef");
    expect(prompt).toContain("bounded-span");
    expect(prompt).not.toContain("secret-tail");
  });

  it("parses and validates teacher decisions", () => {
    const parsed = parseTeacherDecision(request(), `\n\n\`\`\`json\n${decisionJson()}\n\`\`\``);

    expect(parsed).toMatchObject({ schema: "pi-router.decision.v1", checkpointId: "session-1:event-1", action: "run_verifier", policyVersion: "teacher/openai-codex/gpt-5.5/request/request-1" });
    expect(() => parseTeacherDecision(request(), decisionJson("stop_and_ask_user"))).toThrow(/not allowed/);
    expect(() => parseTeacherDecision(request(), JSON.stringify({
      schema: "pi-router.decision.v1",
      checkpointId: "session-1:event-1",
      action: "run_verifier",
      confidence: 0.8,
      reason: "missing fields",
    }))).toThrow(/adviceShape invalid/);

    const withExtras = parseTeacherDecision(request(), JSON.stringify({
      ...JSON.parse(decisionJson()),
      reason: "The transcript says \"this is a very long raw transcript quote that should not be stored in labels\" and token=secret",
      transcriptExcerpt: "do not persist me",
      policyVersion: "model-supplied",
    }));
    expect(withExtras.policyVersion).toBe("teacher/openai-codex/gpt-5.5/request/request-1");
    expect(JSON.stringify(withExtras)).not.toContain("transcriptExcerpt");
    expect(withExtras.reason).not.toContain("very long raw transcript quote");
    expect(withExtras.reason).not.toContain("token=secret");
  });

  it("runs an injected teacher executor and writes decisions plus labels", async () => {
    const requestsPath = tempFile("requests.jsonl");
    const decisionsPath = tempFile("teacher-decisions.jsonl");
    const labelsPath = tempFile("teacher-labels.jsonl");
    writeFileSync(requestsPath, `${JSON.stringify(request())}\n`);
    const executor: TeacherModelExecutor = ({ prompt }) => {
      expect(prompt).toContain("session-1:event-1");
      return decisionJson();
    };

    const summary = await runTeacherLabeling({
      requestsPath,
      decisionsOutputPath: decisionsPath,
      labelsOutputPath: labelsPath,
      executor,
      generatedAt: "2026-06-14T00:00:00.000Z",
    });

    expect(summary).toMatchObject({ schema: "pi-router.teacher-run-summary.v1", teacher: "openai-codex/gpt-5.5", teachers: ["openai-codex/gpt-5.5"], requests: 1, decisions: 1, labels: 1, dryRun: false });
    expect(readFileSync(decisionsPath, "utf8")).toContain("pi-router.decision.v1");
    const label = JSON.parse(readFileSync(labelsPath, "utf8").trim());
    expect(label).toMatchObject({ schema: "pi-router.teacher-label.v1", source: "teacher-output", suggestedAction: "run_verifier" });
  });

  it("supports dry-run without model calls", async () => {
    const requestsPath = tempFile("requests.jsonl");
    const decisionsPath = tempFile("teacher-decisions.jsonl");
    const labelsPath = tempFile("teacher-labels.jsonl");
    writeFileSync(requestsPath, `${JSON.stringify(request())}\n`);

    const summary = await runTeacherLabeling({ requestsPath, decisionsOutputPath: decisionsPath, labelsOutputPath: labelsPath, dryRun: true });

    expect(summary).toMatchObject({ requests: 1, decisions: 0, labels: 0, dryRun: true });
    expect(readFileSync(decisionsPath, "utf8")).toBe("");
    expect(readFileSync(labelsPath, "utf8")).toBe("");
  });
});
