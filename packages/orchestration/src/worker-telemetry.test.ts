import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyWorkerOutcome,
  clearWorkerRequestTracking,
  recordWorkerRequest,
  recordWorkerResult,
} from "./worker-telemetry.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-rogue-worker-telemetry-")), "events.jsonl");
}

afterEach(() => clearWorkerRequestTracking());

describe("worker telemetry", () => {
  it("classifies terminal outcomes with timeout precedence", () => {
    expect(classifyWorkerOutcome({ hasOutput: true })).toBe("success");
    expect(classifyWorkerOutcome({ timedOut: true, hasError: true })).toBe("timeout");
    expect(classifyWorkerOutcome({ hasError: true, abandoned: true })).toBe("failure");
    expect(classifyWorkerOutcome({ abandoned: true, isPartial: true })).toBe("abandoned");
    expect(classifyWorkerOutcome({})).toBeNull();
  });

  it("records a request and matching result in the router ledger schema", () => {
    const path = ledgerPath();
    const request = recordWorkerRequest({
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      ledgerPath: path,
      model: "local/qwen3.6-35b-a3b",
      inputSummary: "implement bounded worker policy",
      recordedAt: "2026-07-17T00:00:00.000Z",
    });
    const result = recordWorkerResult({
      childSessionId: "child-1",
      ledgerPath: path,
      outputSummary: "implemented and tested",
      elapsedMs: 1200,
      outcome: "success",
      acceptedIntoParent: true,
      useful: true,
      recordedAt: "2026-07-17T00:00:01.200Z",
    });

    expect(request.schema).toBe("pi-router.subagent-ledger-event.v1");
    expect(request.phase).toBe("request");
    expect(result.phase).toBe("result");
    expect(result.outcome).toBe("success");
    expect(result.elapsedMs).toBe(1200);
    expect(result.childSessionId).toBe(request.childSessionId);
    expect(result.inputSummaryHash).toBe(request.inputSummaryHash);
    rmSync(path, { recursive: true, force: true });
  });

  it("rejects a result without a tracked request", () => {
    expect(() => recordWorkerResult({ childSessionId: "missing", ledgerPath: ledgerPath() })).toThrow("No pending worker request");
  });
});
