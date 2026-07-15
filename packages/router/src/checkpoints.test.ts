import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCheckpoints,
  rebuildCheckpointsFromSession,
  streamCheckpointsFromSessionPath,
  streamCheckpointsFromSessionPathWithReplay,
  writeCheckpointsJsonl,
} from "./checkpoints.js";
import { readPiSession } from "./session-reader.js";

function writeFixture(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-router-"));
  const path = join(dir, "2026-06-12T00-00-00Z_fixture.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function fixtureSession(): string {
  return writeFixture([
    { type: "session", version: 1, id: "session-1", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/repo/example" },
    { type: "model_change", id: "m1", timestamp: "2026-06-12T00:00:01.000Z", provider: "local", modelId: "qwen-local" },
    { type: "message", id: "u1", timestamp: "2026-06-12T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "please fix the failing tests" }] } },
    { type: "message", id: "a1", timestamp: "2026-06-12T00:00:03.000Z", message: { role: "assistant", provider: "local", model: "qwen-local", usage: { inputTokens: 1234 }, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test -- --runInBand src/foo.test.ts" } }] } },
    { type: "message", id: "t1", timestamp: "2026-06-12T00:00:04.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true, content: [{ type: "text", text: "FAIL src/foo.test.ts\nError: boom" }] } },
    { type: "message", id: "a2", timestamp: "2026-06-12T00:00:05.000Z", message: { role: "assistant", provider: "local", model: "qwen-local", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "npm test -- --runInBand src/foo.test.ts" } }] } },
    { type: "message", id: "t2", timestamp: "2026-06-12T00:00:06.000Z", message: { role: "toolResult", toolCallId: "call-2", toolName: "bash", isError: true, content: [{ type: "text", text: "FAIL src/foo.test.ts\nError: boom" }] } },
  ]);
}

describe("trajectory router checkpoint rebuild", () => {
  it("reads Pi session JSONL and extracts command/tool metadata", () => {
    const session = readPiSession(fixtureSession());

    expect(session.id).toBe("2026-06-12T00-00-00Z_fixture");
    expect(session.cwd).toBe("/repo/example");
    expect(session.events).toHaveLength(7);
    expect(session.events[3].commandEvents[0]).toMatchObject({ toolName: "bash", isVerifier: true });
    expect(session.events[4].toolResult).toMatchObject({ toolName: "bash", isError: true });
  });

  it("builds compact derived checkpoints without raw transcript content", () => {
    const checkpoints = rebuildCheckpointsFromSession(fixtureSession());
    const last = checkpoints.at(-1);

    expect(last?.schema).toBe("pi-router.checkpoint.v1");
    expect(last?.rawSessionRef).toMatchObject({ schema: "pi-router.raw-session-ref.v1", fromEvent: 0, toEvent: 6 });
    expect(last?.activeModel).toBe("qwen-local");
    expect(last?.provider).toBe("local");
    expect(last?.phase).toBe("debug");
    expect(last?.features.contextTokensApprox).toBe(1234);
    expect(last?.features.sameCommandRepeatedCount).toBe(2);
    expect(last?.features.sameErrorRepeatedCount).toBe(2);
    expect(last?.features.verifierUsed).toBe(true);
    expect(last?.features.loopScore).toBeGreaterThan(0);
    expect(last?.recent.lastCommandHash).toBeTruthy();
    expect(last?.recent.lastErrorHash).toBeTruthy();
    expect(last?.recent.touchedFileHashes).toHaveLength(1);

    const serialized = JSON.stringify(last);
    expect(serialized).not.toContain("please fix the failing tests");
    expect(serialized).not.toContain("npm test");
    expect(serialized).not.toContain("Error: boom");
    expect(serialized).not.toContain("src/foo.test.ts");
  });

  it("streams checkpoints equivalent to the sync fixture API", async () => {
    const path = fixtureSession();
    const sync = rebuildCheckpointsFromSession(path).map((checkpoint) => checkpoint.checkpointId);
    const streamed: string[] = [];

    for await (const checkpoint of streamCheckpointsFromSessionPath(path)) streamed.push(checkpoint.checkpointId);

    expect(streamed).toEqual(sync);
  });

  it("replays checkpoint state from cached suffix without reprocessing unchanged session prefixes", async () => {
    const path = fixtureSession();
    const first = await streamCheckpointsFromSessionPathWithReplay(path, {
      fromByteStart: 0,
      fromEventIndex: 0,
    });

    expect(first.latestCheckpoint).not.toBeNull();
    expect(first.parsedEventCount).toBe(7);
    expect(first.nextByteOffset).toBeGreaterThan(0);

    const unchanged = await streamCheckpointsFromSessionPathWithReplay(path, {
      fromByteStart: first.nextByteOffset,
      fromEventIndex: first.nextEventIndex,
      sessionCwd: first.sessionCwd,
      buildState: first.buildState,
      replayRefs: first.replayRefs,
    });

    expect(unchanged.parsedEventCount).toBe(0);
    expect(unchanged.latestCheckpoint).toBeNull();

    appendFileSync(
      path,
      `${JSON.stringify({
        type: "message",
        id: "a3",
        message: {
          role: "assistant",
          provider: "local",
          model: "qwen-local",
          content: [{ type: "text", text: "continue" }],
        },
      })}\n`,
    );

    const replayed = await streamCheckpointsFromSessionPathWithReplay(path, {
      fromByteStart: first.nextByteOffset,
      fromEventIndex: first.nextEventIndex,
      sessionCwd: unchanged.sessionCwd,
      buildState: unchanged.buildState,
      replayRefs: unchanged.replayRefs,
    });

    expect(replayed.parsedEventCount).toBe(1);
    expect(replayed.latestCheckpoint?.checkpointId).toBe("2026-06-12T00-00-00Z_fixture:event-7");
  });

  it("writes checkpoints as JSONL", () => {
    const session = readPiSession(fixtureSession());
    const checkpoints = buildCheckpoints(session);
    const output = join(mkdtempSync(join(tmpdir(), "pi-router-out-")), "checkpoints.jsonl");

    writeCheckpointsJsonl(checkpoints, output);

    const lines = readFileSync(output, "utf8").trim().split("\n");
    expect(lines).toHaveLength(checkpoints.length);
    expect(JSON.parse(lines.at(-1) || "{}").checkpointId).toBe(checkpoints.at(-1)?.checkpointId);
  });
});
