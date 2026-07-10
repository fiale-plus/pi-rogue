import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function ctx(path: string) {
  return { sessionManager: { getSessionFile: () => path } };
}

describe("orchestration session identity", () => {
  it("isolates files and pending-goal locks for same-basename sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const internal = await import("./internal.js");
    const goalResolution = await import("./goal-resolution.js");
    const firstCtx = ctx("/tmp/repo-a/shared.jsonl");
    const secondCtx = ctx("/tmp/repo-b/shared.jsonl");

    expect(internal.sessionKey(firstCtx)).not.toBe(internal.sessionKey(secondCtx));
    const firstGoal = internal.sessionFile("orchestration", firstCtx, "goal.md");
    const secondGoal = internal.sessionFile("orchestration", secondCtx, "goal.md");
    expect(firstGoal).not.toBe(secondGoal);

    writeFileSync(firstGoal, "first\n", "utf8");
    writeFileSync(secondGoal, "second\n", "utf8");
    expect(readFileSync(firstGoal, "utf8")).toBe("first\n");
    expect(readFileSync(secondGoal, "utf8")).toBe("second\n");

    goalResolution.beginGoalCheck(firstCtx);
    expect(goalResolution.hasGoalCheckPending(firstCtx)).toBe(true);
    expect(goalResolution.hasGoalCheckPending(secondCtx)).toBe(false);
    goalResolution.endGoalCheck(firstCtx);
  });

  it("allows only one v2 session to claim ambiguous basename-only state", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionFile } = await import("./internal.js");
    const legacyDir = join(home, ".pi", "agent", "fiale-plus", "orchestration", "shared");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "goal.md"), "legacy\n", "utf8");

    const firstGoal = sessionFile("orchestration", ctx("/tmp/repo-a/shared.jsonl"), "goal.md");
    const secondGoal = sessionFile("orchestration", ctx("/tmp/repo-b/shared.jsonl"), "goal.md");

    expect(readFileSync(firstGoal, "utf8")).toBe("legacy\n");
    expect(() => readFileSync(secondGoal, "utf8")).toThrow();
    writeFileSync(firstGoal, "first\n", "utf8");
    expect(() => readFileSync(secondGoal, "utf8")).toThrow();
  });
});
