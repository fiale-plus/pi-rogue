import { describe, expect, it } from "vitest";
import { buildBoardLedger } from "./board.js";
import { defaultBoardWatchConfig, defaultBoardWatchState, normalizeBoardWatchConfig, runBoardWatch } from "./board-watcher.js";

function riskyLedger(turn = 1) {
  return buildBoardLedger([
    { type: "session", id: "watch-session" },
    { type: "turn", turn },
    { type: "file_changed", path: "src/change.ts", turn },
  ]);
}

describe("Board watcher", () => {
  it("defaults to deterministic shadow mode", () => {
    expect(defaultBoardWatchConfig()).toEqual({ mode: "shadow", cooldownTurns: 3, maxInterventions: 4, headEscalation: "off", headMaxCalls: 1 });
    expect(defaultBoardWatchState()).toEqual({ runs: 0, interventions: 0, headAttempts: 0, suppressed: 0 });
    expect(normalizeBoardWatchConfig({ mode: "intervene", cooldownTurns: 999, maxInterventions: -1, headEscalation: "enabled", headMaxCalls: 99 })).toEqual({ mode: "intervene", cooldownTurns: 100, maxInterventions: 0, headEscalation: "enabled", headMaxCalls: 4 });
  });

  it("records material risks without calling a model or queuing advice in shadow mode", () => {
    const result = runBoardWatch(defaultBoardWatchConfig(), defaultBoardWatchState(), riskyLedger(), 1);
    expect(result.decision.action).toBe("would_whisper");
    expect(result.advice).toBeUndefined();
    expect(result.state.runs).toBe(1);
    expect(result.state.interventions).toBe(0);
  });

  it("queues one bounded non-binding intervention and deduplicates it", () => {
    const config = { ...defaultBoardWatchConfig(), mode: "intervene" as const, cooldownTurns: 0 };
    const first = runBoardWatch(config, defaultBoardWatchState(), riskyLedger(), 1);
    expect(first.advice).toMatchObject({ details: { nonBinding: true, readOnly: true } });
    expect(first.advice?.content.length).toBeLessThanOrEqual(1800);
    const duplicate = runBoardWatch(config, first.state, riskyLedger(), 2);
    expect(duplicate.advice).toBeUndefined();
    expect(duplicate.skipped).toBe("duplicate");
    expect(duplicate.state.suppressed).toBe(1);
  });

  it("enforces cooldown for a changed risk fingerprint", () => {
    const config = { ...defaultBoardWatchConfig(), mode: "intervene" as const, cooldownTurns: 3 };
    const first = runBoardWatch(config, defaultBoardWatchState(), riskyLedger(1), 1);
    const changed = runBoardWatch(config, first.state, riskyLedger(2), 2);
    expect(changed.advice).toBeUndefined();
    expect(changed.skipped).toBe("cooldown");
    const consecutive = runBoardWatch(config, changed.state, riskyLedger(3), 3);
    expect(consecutive.advice).toBeUndefined();
    expect(consecutive.skipped).toBe("cooldown");
    const afterCooldown = runBoardWatch(config, consecutive.state, riskyLedger(4), 4);
    expect(afterCooldown.advice).toBeDefined();
  });
});
