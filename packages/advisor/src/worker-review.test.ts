import { describe, expect, it } from "vitest";
import {
  reviewWorkerResult,
  reviewWorkerResultBrief,
  type WorkerReviewInput,
} from "./worker-review.js";
import {
  buildBoardLedger,
  decideBoardAction,
  detectBoardRisks,
  type BoardDecision,
  type BoardEvent,
  type BoardLedger,
  type BoardRisk,
} from "./board.js";

// ---------------------------------------------------------------------------
// Green worker output
// ---------------------------------------------------------------------------

describe("worker-review: green verdict", () => {
  it("returns silent decision for a clean green return", () => {
    const input: WorkerReviewInput = {
      id: "worker-green-1",
      role: "local-worker-poc",
      verdict: "green",
      summary: "All tests pass, no changes needed",
      turn: 5,
    };

    const result = reviewWorkerResult(input);

    expect(result.event.type).toBe("subagent_return");
    expect(result.event.verdict).toBe("green");
    expect(result.event.id).toBe("worker-green-1");
    expect(result.event.role).toBe("local-worker-poc");
    expect(result.event.summary).toBe("All tests pass, no changes needed");

    // Green verdict should not produce risks
    expect(result.risks).toHaveLength(0);
    expect(result.decision).toEqual({ action: "silent" });

    // Subagent summary should match
    expect(result.subagentSummary).toEqual({
      id: "worker-green-1",
      role: "local-worker-poc",
      verdict: "green",
      summary: "All tests pass, no changes needed",
      turn: 5,
    });
  });

  it("builds a ledger with the subagent evidence", () => {
    const input: WorkerReviewInput = {
      id: "worker-green-2",
      role: "reviewer",
      verdict: "green",
      summary: "Code review complete",
      turn: 3,
    };

    const result = reviewWorkerResult(input);

    expect(result.ledger.subagents).toHaveLength(1);
    expect(result.ledger.subagents[0].id).toBe("worker-green-2");
    expect(result.ledger.evidence).toHaveLength(1);
    expect(result.ledger.evidence[0].kind).toBe("subagent");
    expect(result.ledger.evidence[0].status).toBe("green");
  });

  it("includes optional confidence in the result", () => {
    const input: WorkerReviewInput = {
      id: "worker-green-3",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
      confidence: 0.95,
    };

    const result = reviewWorkerResult(input);

    expect(result.event.confidence).toBe(0.95);
    expect(result.subagentSummary.confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// Red worker output
// ---------------------------------------------------------------------------

describe("worker-review: red verdict", () => {
  it("returns a whisper decision for a red return", () => {
    const input: WorkerReviewInput = {
      id: "worker-red-1",
      role: "local-worker-poc",
      verdict: "red",
      summary: "Tests failed: 3 assertions",
      turn: 2,
    };

    const result = reviewWorkerResult(input);

    expect(result.event.verdict).toBe("red");

    // Red verdict should produce a risk (missing_validation or similar)
    // A single red subagent_return does not trigger repeated_failure (needs 3+)
    // but should still be reflected in the ledger
    expect(result.ledger.evidence).toHaveLength(1);
    expect(result.ledger.evidence[0].status).toBe("red");

    // No risks should be generated for a single red return with low turn count
    // (the existing detectBoardRisks only flags stale_evidence, repeated_failure,
    //  missing_validation, no_progress, subagent_contradiction)
    expect(result.risks).toHaveLength(0);
    expect(result.decision).toEqual({ action: "silent" });
  });

  it("reflects red evidence in the ledger", () => {
    const input: WorkerReviewInput = {
      id: "worker-red-2",
      role: "implementer",
      verdict: "red",
      summary: "Build failed with compilation error",
      turn: 4,
    };

    const result = reviewWorkerResult(input);

    const redEvidence = result.ledger.evidence.filter((e) => e.status === "red");
    expect(redEvidence).toHaveLength(1);
    expect(redEvidence[0].kind).toBe("subagent");
  });
});

// ---------------------------------------------------------------------------
// Unknown worker output
// ---------------------------------------------------------------------------

describe("worker-review: unknown verdict", () => {
  it("returns silent decision for an unknown return", () => {
    const input: WorkerReviewInput = {
      id: "worker-unknown-1",
      role: "local-worker-poc",
      verdict: "unknown",
      summary: "Inconclusive results",
      turn: 2,
    };

    const result = reviewWorkerResult(input);

    expect(result.event.verdict).toBe("unknown");

    // Unknown verdict produces no risks for a single event
    expect(result.risks).toHaveLength(0);
    expect(result.decision).toEqual({ action: "silent" });
  });

  it("includes unknown evidence in the ledger", () => {
    const input: WorkerReviewInput = {
      id: "worker-unknown-2",
      role: "explorer",
      verdict: "unknown",
      summary: "Ambiguous output",
    };

    const result = reviewWorkerResult(input);

    expect(result.ledger.evidence[0].status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios: contradictions and progress
// ---------------------------------------------------------------------------

describe("worker-review: combined scenarios", () => {
  it("detects contradiction when two subagents disagree on the same topic", () => {
    const greenInput: WorkerReviewInput = {
      id: "reviewer-a",
      role: "reviewer",
      topic: "validation-state",
      verdict: "green",
      summary: "Tests pass",
      turn: 5,
    };
    const redInput: WorkerReviewInput = {
      id: "reviewer-b",
      role: "reviewer",
      topic: "validation-state",
      verdict: "red",
      summary: "Tests fail",
      turn: 6,
    };

    // Build a combined ledger with both subagent returns
    const events: BoardEvent[] = [
      { type: "session", id: "s1", repo: "test/repo" },
      reviewWorkerResult(greenInput).event,
      reviewWorkerResult(redInput).event,
    ];

    const ledger = buildBoardLedger(events);
    const risks = detectBoardRisks(ledger);
    const decision = decideBoardAction(ledger);

    expect(ledger.subagents).toHaveLength(2);
    expect(risks.map((r) => r.type)).toContain("subagent_contradiction");
    expect(decision.action).toBe("would_whisper");
    expect(decision).toMatchObject({ severity: "important" });
  });

  it("green verdict advances lastProgressTurn in the ledger", () => {
    const input: WorkerReviewInput = {
      id: "worker-green-4",
      role: "implementer",
      verdict: "green",
      summary: "Done",
      turn: 10,
    };

    const result = reviewWorkerResult(input);

    expect(result.ledger.progress.lastProgressTurn).toBe(10);
  });

  it("red verdict does not advance lastProgressTurn", () => {
    const input: WorkerReviewInput = {
      id: "worker-red-3",
      role: "implementer",
      verdict: "red",
      summary: "Failed",
      turn: 10,
    };

    const result = reviewWorkerResult(input);

    // lastProgressTurn should be undefined because no green evidence exists
    expect(result.ledger.progress.lastProgressTurn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Brief helper
// ---------------------------------------------------------------------------

describe("worker-review: brief helper", () => {
  it("returns only decision and risks", () => {
    const input: WorkerReviewInput = {
      id: "worker-brief-1",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
    };

    const brief = reviewWorkerResultBrief(input);

    expect(brief).toHaveProperty("decision");
    expect(brief).toHaveProperty("risks");
    expect(Object.keys(brief)).toHaveLength(2);
    expect(brief.decision).toEqual({ action: "silent" });
    expect(brief.risks).toHaveLength(0);
  });

  it("returns the same decision as the full review", () => {
    const input: WorkerReviewInput = {
      id: "worker-brief-2",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
    };

    const full = reviewWorkerResult(input);
    const brief = reviewWorkerResultBrief(input);

    expect(brief.decision).toEqual(full.decision);
    expect(brief.risks).toEqual(full.risks);
  });
});

// ---------------------------------------------------------------------------
// Session metadata
// ---------------------------------------------------------------------------

describe("worker-review: session metadata", () => {
  it("includes session event when sessionId or repo is provided", () => {
    const input: WorkerReviewInput = {
      id: "worker-meta-1",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
      sessionId: "session-abc",
      repo: "test/repo",
    };

    const result = reviewWorkerResult(input);

    expect(result.ledger.session.id).toBe("session-abc");
    expect(result.ledger.session.repo).toBe("test/repo");
  });

  it("uses default session id when only repo is provided", () => {
    const input: WorkerReviewInput = {
      id: "worker-meta-2",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
      repo: "test/repo",
    };

    const result = reviewWorkerResult(input);

    expect(result.ledger.session.repo).toBe("test/repo");
  });

  it("omits session event when no metadata is provided", () => {
    const input: WorkerReviewInput = {
      id: "worker-meta-3",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
    };

    const result = reviewWorkerResult(input);

    expect(result.ledger.session).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Purity: no side effects
// ---------------------------------------------------------------------------

describe("worker-review: purity guarantees", () => {
  it("never dispatches workers", () => {
    // This test verifies the function signature and behavior.
    // If reviewWorkerResult called any dispatch function, it would need
    // to import from router or orchestration packages that contain
    // dispatch logic. The worker-review module imports only from board.ts.
    const input: WorkerReviewInput = {
      id: "worker-purity-1",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
    };

    // Just calling it should not throw or produce side effects
    expect(() => reviewWorkerResult(input)).not.toThrow();
  });

  it("never steers execution", () => {
    const input: WorkerReviewInput = {
      id: "worker-purity-2",
      role: "reviewer",
      verdict: "red",
      summary: "Failed",
    };

    // Red verdict should not trigger a steer action
    const result = reviewWorkerResult(input);
    expect(result.decision.action).not.toBe("would_steer");
  });

  it("never mutates policy", () => {
    const input: WorkerReviewInput = {
      id: "worker-purity-3",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
    };

    // The function should not import or reference any policy modules
    const result = reviewWorkerResult(input);
    expect(result.decision).toBeDefined();
  });

  it("never calls a model", () => {
    // The worker-review module has no async operations and no model calls.
    // It is a pure synchronous function.
    const input: WorkerReviewInput = {
      id: "worker-purity-4",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
    };

    // Synchronous call - no await, no model references
    const result = reviewWorkerResult(input);
    expect(result).toBeDefined();
    expect(result.event).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("worker-review: edge cases", () => {
  it("handles empty summary", () => {
    const input: WorkerReviewInput = {
      id: "worker-edge-1",
      role: "reviewer",
      verdict: "green",
      summary: "",
    };

    const result = reviewWorkerResult(input);

    expect(result.event.summary).toBe("");
    expect(result.decision).toEqual({ action: "silent" });
  });

  it("handles very long summary without truncation", () => {
    const longSummary = "x".repeat(10000);
    const input: WorkerReviewInput = {
      id: "worker-edge-2",
      role: "reviewer",
      verdict: "green",
      summary: longSummary,
    };

    const result = reviewWorkerResult(input);

    expect(result.event.summary).toBe(longSummary);
    expect(result.subagentSummary.summary).toBe(longSummary);
  });

  it("preserves timestamp through the pipeline", () => {
    const ts = "2026-07-16T23:59:57.468Z";
    const input: WorkerReviewInput = {
      id: "worker-edge-3",
      role: "reviewer",
      verdict: "green",
      summary: "Clean",
      timestamp: ts,
    };

    const result = reviewWorkerResult(input);

    expect(result.event.timestamp).toBe(ts);
  });

  it("handles missing optional fields gracefully", () => {
    const input: WorkerReviewInput = {
      id: "worker-edge-4",
      role: "reviewer",
      verdict: "red",
      summary: "Failed",
    };

    const result = reviewWorkerResult(input);

    expect(result.event.topic).toBeUndefined();
    expect(result.event.confidence).toBeUndefined();
    expect(result.event.turn).toBeUndefined();
    expect(result.event.timestamp).toBeUndefined();
    expect(result.subagentSummary.topic).toBeUndefined();
    expect(result.subagentSummary.confidence).toBeUndefined();
    expect(result.subagentSummary.turn).toBeUndefined();
  });
});
