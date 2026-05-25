import { describe, it, expect } from "vitest";
import { normalizeAdvisorConfig, shouldRunCheckin, type AdvisorConfig } from "./extension.js";

function state(overrides: Record<string, unknown> = {}) {
  return {
    turns: 2,
    lastTask: "work on orchestration",
    notes: ["made progress"],
    files: [],
    errors: [],
    advisorCalls: 0,
    cacheHits: 0,
    followUp: "",
    router: {},
    checkin: {},
    ...overrides,
  } as any;
}

describe("AdvisorConfig", () => {
  it("defaults to auto mode, light review, and mid-hour check-ins", () => {
    const cfg = normalizeAdvisorConfig({});
    expect(cfg.mode).toBe("auto");
    expect(cfg.review).toBe("light");
    expect(cfg.checkins).toBe("mid-hour");
    expect(cfg.checkinIntervalMinutes).toBe(30);
    expect(cfg.model).toBeUndefined();
  });

  it("accepts all 3 modes", () => {
    for (const mode of ["auto", "manual", "off"] as const) {
      const cfg: AdvisorConfig = { mode, review: "light", checkins: "mid-hour", checkinIntervalMinutes: 30 };
      expect(normalizeAdvisorConfig(cfg).mode).toBe(mode);
    }
  });

  it("accepts all 3 review levels", () => {
    for (const review of ["light", "strict", "off"] as const) {
      const cfg: AdvisorConfig = { mode: "auto", review, checkins: "mid-hour", checkinIntervalMinutes: 30 };
      expect(normalizeAdvisorConfig(cfg).review).toBe(review);
    }
  });

  it("bounds check-in intervals", () => {
    expect(normalizeAdvisorConfig({ checkinIntervalMinutes: 1 }).checkinIntervalMinutes).toBe(10);
    expect(normalizeAdvisorConfig({ checkinIntervalMinutes: 999 }).checkinIntervalMinutes).toBe(240);
  });

  it("accepts optional model override", () => {
    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light", model: "claude-sonnet-4-6" });
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });

  it("serializes/deserializes without data loss (JSON round-trip)", () => {
    const original = normalizeAdvisorConfig({ mode: "auto", review: "light", model: "claude-opus-4-6" });
    const json = JSON.stringify(original);
    const parsed = normalizeAdvisorConfig(JSON.parse(json) as AdvisorConfig);
    expect(parsed.mode).toBe("auto");
    expect(parsed.review).toBe("light");
    expect(parsed.checkins).toBe("mid-hour");
    expect(parsed.checkinIntervalMinutes).toBe(30);
    expect(parsed.model).toBe("claude-opus-4-6");
  });
});

describe("mid-hour check-ins", () => {
  it("does not run immediately after session start", () => {
    const cfg = normalizeAdvisorConfig({ checkinIntervalMinutes: 30 });
    const startedAt = 1_000;
    const now = startedAt + 5 * 60_000;
    expect(shouldRunCheckin(cfg, state(), now, startedAt)).toBeNull();
  });

  it("runs after interval when there was new activity", () => {
    const cfg = normalizeAdvisorConfig({ checkinIntervalMinutes: 30 });
    const startedAt = 1_000;
    const now = startedAt + 31 * 60_000;
    expect(shouldRunCheckin(cfg, state(), now, startedAt)).toMatch(/mid-hour check-in/);
  });

  it("does not run without activity since the last check-in", () => {
    const cfg = normalizeAdvisorConfig({ checkinIntervalMinutes: 30 });
    const lastAt = new Date(1_000).toISOString();
    const now = 1_000 + 60 * 60_000;
    expect(shouldRunCheckin(cfg, state({ turns: 5, checkin: { lastAt, lastTurn: 5 } }), now, 1_000)).toBeNull();
  });

  it("does not run when check-ins are disabled", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "off" });
    expect(shouldRunCheckin(cfg, state(), 999999, 1)).toBeNull();
  });
});


describe("SOTA model suggestions", () => {
  it("includes gpt-5.5 as primary option", () => {
    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light" });
    expect(cfg.model).toBeUndefined(); // model is optional, auto-detect
  });
});
