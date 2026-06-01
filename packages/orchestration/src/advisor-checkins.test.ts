import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resetAdvisorSessionContext, setAdvisorCheckinsEnabled } from "./advisor-checkins.js";

const dirs: string[] = [];

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-checkins-"));
  dirs.push(dir);
  const file = join(dir, "advisor", "config.json");
  mkdirSync(join(dir, "advisor"), { recursive: true });
  return file;
}

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-state-"));
  dirs.push(dir);
  const base = join(dir, "advisor");
  mkdirSync(base, { recursive: true });
  return {
    config: join(base, "config.json"),
    state: join(base, "state.json"),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("advisor check-in lifecycle bridge", () => {
  it("turns advisor check-ins on while preserving existing config and captures start time", () => {
    const file = tempConfig();
    writeFileSync(file, JSON.stringify({ mode: "auto", review: "light", model: "openai-codex/gpt-5.5" }), "utf8");
    const startedAt = Date.now();

    const next = setAdvisorCheckinsEnabled(true, file);

    expect(next).toMatchObject({ mode: "auto", review: "light", model: "openai-codex/gpt-5.5", checkins: "mid-hour" });
    expect(next.checkinStartedAt).toBeTypeOf("number");
    expect(next.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.checkins).toBe("mid-hour");
    expect(parsed.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);
  });

  it("turns advisor check-ins off", () => {
    const file = tempConfig();
    writeFileSync(file, JSON.stringify({ checkins: "mid-hour", checkinIntervalMinutes: 30 }), "utf8");

    const next = setAdvisorCheckinsEnabled(false, file);

    expect(next).toMatchObject({ checkins: "off", checkinIntervalMinutes: 30 });
    expect(JSON.parse(readFileSync(file, "utf8")).checkins).toBe("off");
  });

  it("resets advisor brief context and check-in timing for a new goal", () => {
    const { config, state } = tempState();
    const startedAt = Date.now();
    writeFileSync(config, JSON.stringify({
      mode: "auto",
      review: "light",
      checkins: "mid-hour",
      checkinIntervalMinutes: 30,
      checkinStartedAt: 1,
    }), "utf8");
    writeFileSync(state, JSON.stringify({
      turns: 9,
      lastTask: "old task",
      notes: ["old note"],
      files: ["old.ts"],
      errors: ["old error"],
      advisorCalls: 3,
      cacheHits: 7,
      followUp: "old follow-up",
      reviewControl: {
        status: "running",
        pending: true,
        consumed: false,
        running: true,
        lastDecision: "review",
        lastReason: "manual checkpoint",
      },
      router: { preflight: { label: "continue" } },
      checkin: {
        lastAt: "2026-05-29T00:00:00.000Z",
        lastTurn: 8,
        lastReason: "mid-hour check-in after 1 new turn(s)",
        queued: true,
        queuedReason: "queued mid-session check-in",
      },
    }), "utf8");

    const next = resetAdvisorSessionContext(config, state);

    expect(next.state).toMatchObject({
      turns: 0,
      lastTask: "",
      notes: [],
      files: [],
      errors: [],
      advisorCalls: 3,
      cacheHits: 7,
      followUp: "",
      router: {},
      checkin: { queued: false },
      reviewControl: {
        status: "idle",
        pending: false,
        consumed: true,
        running: false,
      },
    });
    expect(next.config.checkinStartedAt).toBeTypeOf("number");
    expect(next.config.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);

    const parsedState = JSON.parse(readFileSync(state, "utf8"));
    expect(parsedState.lastTask).toBe("");
    expect(parsedState.notes).toEqual([]);
    expect(parsedState.checkin).toEqual({ queued: false });
    expect(parsedState.reviewControl).toEqual({
      status: "idle",
      pending: false,
      consumed: true,
      running: false,
    });

    const parsedConfig = JSON.parse(readFileSync(config, "utf8"));
    expect(parsedConfig.checkins).toBe("mid-hour");
    expect(parsedConfig.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);
  });
});
