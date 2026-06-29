import { describe, expect, it } from "vitest";
import { boardTelemetryPath, resolveBoardTelemetryScope } from "./board-telemetry.js";

function withEnvSessionId<T>(value: string | undefined, run: () => T): T {
  const original = process.env.PI_ROGUE_SESSION_ID;
  if (value === undefined) {
    delete process.env.PI_ROGUE_SESSION_ID;
  } else {
    process.env.PI_ROGUE_SESSION_ID = value;
  }
  try {
    return run();
  } finally {
    if (original === undefined) {
      delete process.env.PI_ROGUE_SESSION_ID;
    } else {
      process.env.PI_ROGUE_SESSION_ID = original;
    }
  }
}

describe("board telemetry scope", () => {
  it("derives a stable non-generic scope from session file and cwd", () => {
    const ctx = {
      sessionManager: { getSessionFile: () => "/tmp/pi/session.jsonl" },
      cwd: "/tmp/worktree-a",
      session: { id: "session" },
    };
    const scope = resolveBoardTelemetryScope(ctx);
    expect(scope).toMatch(/^board-[a-f0-9]{16}$/);
    expect(boardTelemetryPath(ctx, "board-flight.jsonl")).toContain("/board-sessions/");
    expect(boardTelemetryPath(ctx, "board-flight.jsonl")).toContain(scope!);
  });

  it("keeps different worktrees from colliding", () => {
    const first = resolveBoardTelemetryScope({ cwd: "/tmp/worktree-a", session: { id: "session" } });
    const second = resolveBoardTelemetryScope({ cwd: "/tmp/worktree-b", session: { id: "session" } });
    expect(first).not.toEqual(second);
  });

  it("includes env session id when that is the only available identity", () => {
    withEnvSessionId("env-session-123", () => {
      const scope = resolveBoardTelemetryScope({});
      expect(scope).toMatch(/^board-[a-f0-9]{16}$/);
    });
  });

  it("fails closed when no safe scope exists", () => {
    withEnvSessionId(undefined, () => {
      expect(resolveBoardTelemetryScope({})).toBeUndefined();
      expect(boardTelemetryPath({}, "board-flight.jsonl")).toBeUndefined();
    });
  });
});
