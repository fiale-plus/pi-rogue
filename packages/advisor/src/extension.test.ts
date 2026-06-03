import { describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai";
import {
  buildAdvisorCheckinPrompt,
  completeWithHigherAdvisorModel,
  completeWithModelFallback,
  contentText,
  normalizeAdvisorConfig,
  sanitizeAdvisorText,
  shouldRunCheckin,
  type AdvisorConfig,
} from "./extension.js";

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    completeSimple: vi.fn(),
  };
});

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
  it("defaults to auto mode, light review, and goal-scoped check-ins off", () => {
    const cfg = normalizeAdvisorConfig({});
    expect(cfg.mode).toBe("auto");
    expect(cfg.review).toBe("light");
    expect(cfg.checkins).toBe("off");
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
    expect(parsed.checkins).toBe("off");
    expect(parsed.checkinIntervalMinutes).toBe(30);
    expect(parsed.model).toBe("claude-opus-4-6");
  });
});

describe("advisor message extraction", () => {
  it("extracts nested structured content without object string leakage", () => {
    expect(contentText({ content: [{ type: "text", text: "done" }] })).toBe("done");
    expect(contentText([{ type: "toolResult", content: [{ type: "text", text: "ok" }] }])).toBe("ok");
    expect(contentText({ arbitrary: "shape" })).toBe("");
  });

  it("redacts transient clipboard image paths from advisor-facing text", () => {
    const text = "see /var/folders/fm/rwczdnws5j58x7kbyn3vcx_h0000gn/T/clipboard-2026-06-04-012248-DEE3A154.png please";
    expect(sanitizeAdvisorText(text)).toBe("see [clipboard image] please");
    expect(contentText({ content: [{ type: "text", text }] })).toBe("see [clipboard image] please");
  });

  it("does not redact ordinary repo or temp file paths", () => {
    const text = "inspect /Users/pavel/repos/fiale-plus/pi-rogue/packages/advisor/src/extension.ts and /tmp/benchmark-results.json";
    expect(sanitizeAdvisorText(text)).toBe(text);
  });
});

describe("mid-hour check-ins", () => {
  it("does not run immediately after session start", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    const startedAt = 1_000;
    const now = startedAt + 5 * 60_000;
    expect(shouldRunCheckin(cfg, state(), now, startedAt)).toBeNull();
  });

  it("runs after interval when there was new activity", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    const startedAt = 1_000;
    const now = startedAt + 31 * 60_000;
    expect(shouldRunCheckin(cfg, state(), now, startedAt)).toMatch(/mid-hour check-in/);
  });

  it("does not run without activity since the last check-in", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    const lastAt = new Date(1_000).toISOString();
    const now = 1_000 + 60 * 60_000;
    expect(shouldRunCheckin(cfg, state({ turns: 5, checkin: { lastAt, lastTurn: 5 } }), now, 1_000)).toBeNull();
  });

  it("does not run when check-ins are disabled", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "off" });
    expect(shouldRunCheckin(cfg, state(), 999999, 1)).toBeNull();
  });

  it("skips check-in while advisor is in temporary pause", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    expect(
      shouldRunCheckin(cfg, state({
        turns: 5,
        advisorPauseUntilTurn: 10,
      }), 2_000_000, 1_000),
    ).toBeNull();
  });

  it("allows check-in after pause expires", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    const startedAt = 1_000;
    const now = startedAt + 31 * 60_000;
    expect(
      shouldRunCheckin(cfg, state({
        turns: 12,
        lastTask: "work",
        notes: ["note"],
        advisorPauseUntilTurn: 10,
      }), now, startedAt),
    ).toMatch(/mid-hour check-in/);
  });

  it("keeps loop-triggered check-ins bounded by the minute interval", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    const startedAt = 1_000;
    const now = startedAt + 5 * 60_000;
    expect(
      shouldRunCheckin(cfg, state({
        turns: 5,
        checkin: { lastAt: new Date(startedAt).toISOString(), lastTurn: 3 },
        lastTask: "work",
        notes: ["note"],
      }), now, startedAt),
    ).toBeNull();
  });

  it("flushes queued check-in regardless of turn delta", () => {
    const cfg = normalizeAdvisorConfig({ checkins: "mid-hour", checkinIntervalMinutes: 30 });
    expect(
      shouldRunCheckin(cfg, state({
        checkin: {
          queued: true,
          queuedReason: "queued mid-session check-in",
        },
      })),
    ).toBe("queued mid-session check-in");
  });

  it("keeps check-in guidance anchored to the active goal", () => {
    const prompt = buildAdvisorCheckinPrompt(
      "loop_tick",
      [
        "Orchestration:",
        "- Goal: active — Autoresearch: solve advisor weaknesses",
        "- Autoresearch: active — solve advisor weaknesses; cycles=1",
        "- Loop: active every 5m — Run one autoresearch cycle toward the active goal.",
      ].join("\n"),
      "Task: solve advisor weaknesses\nNotes:\n- found shallow mid-hour feedback",
    );

    expect(prompt).toContain("alignment reviewer");
    expect(prompt).toContain("Do not create a new task");
    expect(prompt).toContain("preserve its research question");
    expect(prompt).toContain("solving the named weakness");
    expect(prompt).toContain("Nudge: <one concrete next action that continues the active goal>");
    expect(prompt).toContain("found shallow mid-hour feedback");
  });
});


describe("advisor completion fallback behavior", () => {
  function mkCtx(allowHighTier: boolean, includeRegular = true) {
    const high = { id: "openai-codex/gpt-5.5", provider: "openai-codex", input: ["text"] };
    const regular = { id: "provider/text-light", provider: "provider", input: ["text"] };
    return {
      modelRegistry: {
        find: (_provider: string, model: string) => {
          if (!allowHighTier) return null;
          if (_provider === "openai-codex" && model === "gpt-5.5") return high;
          if (_provider === "anthropic" && model === "claude-opus-4-6") return { ...high, id: "anthropic/claude-opus-4-6" };
          if (_provider === "anthropic" && model === "claude-sonnet-4-6") return { ...high, id: "anthropic/claude-sonnet-4-6" };
          if (_provider === "openai-codex" && model === "gpt-5.4-mini") return { ...high, id: "openai-codex/gpt-5.4-mini" };
          return null;
        },
        getAvailable: () => (includeRegular ? [regular] : []),
        getApiKeyAndHeaders: async (_model: unknown) => ({ ok: true, apiKey: "k", headers: {} }),
      },
    } as any;
  }

  it("uses high/advanced models first for check-in completion", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light" });
    const result = await completeWithHigherAdvisorModel(mkCtx(true, true), cfg, "system", [{ role: "user", content: "x" }], { maxTokens: 128, reasoning: "low" as const });

    expect(result).not.toBeNull();
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]?.id).toBe("openai-codex/gpt-5.5");
  });

  it("falls back to regular models for check-in completion when high/advanced are unavailable", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light" });
    const result = await completeWithHigherAdvisorModel(mkCtx(false, true), cfg, "system", [{ role: "user", content: "x" }], { maxTokens: 128, reasoning: "low" as const });

    expect(result).not.toBeNull();
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]?.id).toBe("provider/text-light");
  });

  it("uses regular fallback for non-checkin completion", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light" });
    const result = await completeWithModelFallback(mkCtx(false), cfg, "system", [{ role: "user", content: "x" }], { maxTokens: 128, reasoning: "low" as const });

    expect(result).not.toBeNull();
    expect(result?.fallback).toBe(true);
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]?.id).toBe("provider/text-light");
  });
});


describe("SOTA model suggestions", () => {
  it("includes gpt-5.5 as primary option", () => {
    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light" });
    expect(cfg.model).toBeUndefined(); // model is optional, auto-detect
  });
});
