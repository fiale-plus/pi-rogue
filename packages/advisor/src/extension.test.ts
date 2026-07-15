import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  applyAdvisorBoardProfilePlan,
  applyPiRogueConfigurePlan,
  applyPiRoguePostureConfig,
  applyPiRoguePosturePlan,
  budgetBoardEscalationPolicyText,
  buildAdvisorBoardProfilePlan,
  buildAdvisorCheckinPrompt,
  buildPiRogueConfigurePlan,
  buildPiRoguePosturePlan,
  disableAdvisorBoardProfile,
  completeWithHigherAdvisorModel,
  completeWithModelFallback,
  contentText,
  formatAdvisorBinaryGateStatus,
  isGuardedPostureConfig,
  normalizeAdvisorConfig,
  parseCfgPostureArgs,
  parseReviewPayload,
  resolveModelCandidates,
  sanitizeAdvisorText,
  shouldRunCheckin,
  consumeTaskScopedFollowUp,
  isTaskContinuation,
  type AdvisorConfig,
} from "./extension.js";

vi.mock("@earendil-works/pi-ai/compat", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
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
    expect(cfg.profile).toBeUndefined();
    expect(cfg.board).toEqual({ mode: "off" });
    expect(cfg.headOfBoard).toMatchObject({ mode: "off", maxTokens: 1200, reasoning: "medium" });
    expect(cfg.specialistDispatch).toMatchObject({ mode: "suggest", cooldownTurns: 6, maxCallsPerSession: 3, maxCostTier: "cheap", maxTokens: 900 });
  });

  it("accepts all 3 modes", () => {
    for (const mode of ["auto", "manual", "off"] as const) {
      const cfg: AdvisorConfig = { mode, review: "light", checkins: "mid-hour", checkinIntervalMinutes: 30, board: { mode: "off" }, headOfBoard: { mode: "off", maxEvidence: 8, maxRisks: 6, maxFailures: 4, maxSubagents: 6, maxTokens: 1200, reasoning: "medium" }, specialistDispatch: { mode: "suggest", cooldownTurns: 6, maxCallsPerSession: 3, maxCostTier: "cheap", maxTokens: 900 } };
      expect(normalizeAdvisorConfig(cfg).mode).toBe(mode);
    }
  });

  it("accepts all 3 review levels", () => {
    for (const review of ["light", "strict", "off"] as const) {
      const cfg: AdvisorConfig = { mode: "auto", review, checkins: "mid-hour", checkinIntervalMinutes: 30, board: { mode: "off" }, headOfBoard: { mode: "off", maxEvidence: 8, maxRisks: 6, maxFailures: 4, maxSubagents: 6, maxTokens: 1200, reasoning: "medium" }, specialistDispatch: { mode: "suggest", cooldownTurns: 6, maxCallsPerSession: 3, maxCostTier: "cheap", maxTokens: 900 } };
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
    const original = normalizeAdvisorConfig({ mode: "auto", review: "light", model: "claude-opus-4-6", profile: "budget-board" });
    const json = JSON.stringify(original);
    const parsed = normalizeAdvisorConfig(JSON.parse(json) as AdvisorConfig);
    expect(parsed.mode).toBe("auto");
    expect(parsed.review).toBe("light");
    expect(parsed.checkins).toBe("off");
    expect(parsed.checkinIntervalMinutes).toBe(30);
    expect(parsed.model).toBe("claude-opus-4-6");
    expect(parsed.profile).toBe("budget-board");
  });
});

describe("advisor model authentication fallback", () => {
  it("continues when the first candidate auth lookup throws and the second succeeds", async () => {
    const first = { provider: "openai-codex", id: "gpt-5.5", input: ["text"] };
    const second = { provider: "anthropic", id: "claude-opus-4-6", input: ["text"] };
    const attempted: string[] = [];
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === first.provider && id === first.id ? first : provider === second.provider && id === second.id ? second : undefined,
        getAvailable: () => [],
        getApiKeyAndHeaders: async (model: typeof first) => {
          attempted.push(`${model.provider}/${model.id}`);
          if (model === first) throw new Error("credential lookup failed");
          return { ok: true, apiKey: "second-token" };
        },
      },
    };

    const resolved = await resolveModelCandidates(ctx, normalizeAdvisorConfig({}), { allowRegularFallback: false });
    expect(attempted).toEqual(["openai-codex/gpt-5.5", "anthropic/claude-opus-4-6"]);
    expect(resolved.map((entry) => entry.model)).toEqual([second]);
  });

  it("does not let a failed provider suppress a same-id model from another provider", async () => {
    const first = { provider: "provider-a", id: "shared-model", input: ["text"] };
    const second = { provider: "provider-b", id: "shared-model", input: ["text"] };
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === "provider-a" && id === "shared-model" ? first : undefined,
        getAvailable: () => [second],
        getApiKeyAndHeaders: async (model: typeof first) => {
          if (model === first) throw new Error("provider A auth failed");
          return { ok: true, apiKey: "provider-b-token" };
        },
      },
    };

    const resolved = await resolveModelCandidates(ctx, normalizeAdvisorConfig({ model: "provider-a/shared-model" }));
    expect(resolved.map((entry) => entry.model)).toEqual([second]);
  });

  it("attempts every distinct candidate, returns none, and records only sanitized auth diagnostics", async () => {
    const diagnosticsDir = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-auth-"));
    const diagnosticsPath = join(diagnosticsDir, "diagnostics.jsonl");
    const previous = process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH;
    const models = [
      { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
      { provider: "anthropic", id: "claude-opus-4-6", input: ["text"] },
    ];
    const attempted: string[] = [];
    try {
      process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH = diagnosticsPath;
      const ctx = {
        modelRegistry: {
          find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
          getAvailable: () => models,
          getApiKeyAndHeaders: async (model: (typeof models)[number]) => {
            attempted.push(`${model.provider}/${model.id}`);
            throw new Error("secret=sk-sensitive-token-value");
          },
        },
      };

      await expect(resolveModelCandidates(ctx, normalizeAdvisorConfig({}))).resolves.toEqual([]);
      expect(attempted).toEqual(["openai-codex/gpt-5.5", "anthropic/claude-opus-4-6"]);
      const diagnostics = readFileSync(diagnosticsPath, "utf8");
      expect(diagnostics.match(/model_auth_resolution_failed/g)).toHaveLength(2);
      expect(diagnostics).toContain('"category":"auth_lookup_error"');
      expect(diagnostics).toContain("gpt-5.5");
      expect(diagnostics).toContain("claude-opus-4-6");
      expect(diagnostics).not.toContain("sensitive-token-value");
      expect(diagnostics).not.toContain("secret=");
    } finally {
      if (previous === undefined) delete process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH;
      else process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH = previous;
      rmSync(diagnosticsDir, { recursive: true, force: true });
    }
  });

  it("preserves cancellation instead of falling through", async () => {
    const aborted = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const second = { provider: "anthropic", id: "claude-opus-4-6", input: ["text"] };
    const getApiKeyAndHeaders = vi.fn(async () => { throw aborted; });
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.5" ? { provider, id, input: ["text"] } : second,
        getAvailable: () => [],
        getApiKeyAndHeaders,
      },
    };

    await expect(resolveModelCandidates(ctx, normalizeAdvisorConfig({}), { allowRegularFallback: false })).rejects.toBe(aborted);
    expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
  });
});

describe("Advisor binary gate status", () => {
  const usableGate = {
    path: "/tmp/binary-gate-model.json",
    available: true,
    usable: true,
    source: "installed" as const,
    kind: "binary-logreg-v2" as const,
    features: 6000,
    labels: ["continue", "escalate"],
    stacked: true,
    thresholds: { default: 0.5, preflight: 0.7, review: 0.6 },
  };

  it("shows a wired-but-dormant gate under manual mode even when review is enabled", () => {
    const text = formatAdvisorBinaryGateStatus(
      normalizeAdvisorConfig({ mode: "manual", review: "strict" }),
      state({ router: { review: { phase: "review", source: "model", reason: "local gate predicts review", confidence: 0.82 } } }),
      usableGate,
    );

    expect(text).toContain("Binary gate:");
    expect(text).toContain("binary-logreg-v2; features=6000");
    expect(text).toContain("advisor preflight: dormant (mode=manual)");
    expect(text).toContain("advisor review: dormant (mode=manual)");
    expect(text).toContain("can act now: wired but dormant under current advisor config");
    expect(text).toContain("latest route: review: local gate predicts review (confidence=0.82)");
  });

  it("shows active advisor paths when auto mode and review are enabled", () => {
    const text = formatAdvisorBinaryGateStatus(
      normalizeAdvisorConfig({ mode: "auto", review: "light" }),
      state(),
      usableGate,
    );

    expect(text).toContain("advisor preflight: active in auto preflight");
    expect(text).toContain("advisor review: active in light review");
    expect(text).toContain("can act now: yes");
  });

  it("surfaces missing or malformed artifacts as unavailable", () => {
    const text = formatAdvisorBinaryGateStatus(
      normalizeAdvisorConfig({ mode: "auto", review: "light" }),
      state(),
      { path: "/tmp/missing.json", available: false, usable: false, source: "missing", error: "artifact missing" },
    );

    expect(text).toContain("model: unavailable (artifact missing)");
    expect(text).toContain("can act now: no");
  });
});

describe("Advisor budget-board profile", () => {
  function ctx(models: Array<{ provider: string; id: string; input: string[] }> = [
    { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
    { provider: "openai-codex", id: "gpt-5.5-mini", input: ["text"] },
    { provider: "image-only", id: "paint", input: ["image"] },
  ], findOnly: Array<{ provider: string; id: string; input: string[] }> = []) {
    return {
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => [...models, ...findOnly].find((model) => model.provider === provider && model.id === id),
      },
    } as any;
  }

  it("reports explicit escalation limits and cost gates for status output", () => {
    const plan = buildAdvisorBoardProfilePlan(ctx(), normalizeAdvisorConfig({}));
    const text = budgetBoardEscalationPolicyText(plan.advisorConfig);

    expect(text).toContain("profile: active");
    expect(text).toContain("strong-model loop: off");
    expect(text).toContain("triggers=user_request or material Board risk");
    expect(text).toContain("cooldown=6 turns");
    expect(text).toContain("maxCalls=3");
    expect(text).toContain("maxCost=cheap");
    expect(text).toContain("Denials/skips are explicit");
  });

  it("resolves an explicit cheap-driver/strong-advisor plan without mutating global driver defaults", () => {
    const plan = buildAdvisorBoardProfilePlan(ctx(), normalizeAdvisorConfig({}));

    expect(plan.id).toBe("budget-board");
    expect(plan.active).toBe(false);
    expect(plan.driverModel).toBe("openai-codex/gpt-5.5-mini");
    expect(plan.advisorModel).toBe("openai-codex/gpt-5.5");
    expect(plan.headOfBoardModel).toBe("openai-codex/gpt-5.5");
    expect(plan.specialistModel).toBe("openai-codex/gpt-5.5");
    expect(plan.mutatesGlobalDriver).toBe(false);
    expect(plan.advisorConfig.profileRestore).toMatchObject({ mode: "auto", review: "light", checkins: "off" });
    expect(plan.advisorConfig).toMatchObject({
      profile: "budget-board",
      mode: "manual",
      review: "off",
      checkins: "off",
      model: "openai-codex/gpt-5.5",
      board: { mode: "shadow" },
      headOfBoard: { mode: "enabled" },
      specialistDispatch: { mode: "suggest", maxCostTier: "cheap", maxCallsPerSession: 3 },
    });
  });

  it("fails loudly instead of silently falling back when preferred profile models are missing", () => {
    const plan = buildAdvisorBoardProfilePlan(ctx([{ provider: "local", id: "tiny", input: ["text"] }]), normalizeAdvisorConfig({}));

    expect(plan.warnings.join("\n")).toMatch(/No preferred cheap driver/);
    expect(plan.warnings.join("\n")).toMatch(/No preferred strong advisor/);
    expect(() => applyAdvisorBoardProfilePlan(plan)).toThrow(/strong advisor model/);
  });

  it("resolves strong advisor candidates through registry lookup even when not listed as available", () => {
    const plan = buildAdvisorBoardProfilePlan(ctx(
      [{ provider: "openai-codex", id: "gpt-5.5-mini", input: ["text"] }],
      [{ provider: "openai-codex", id: "gpt-5.5", input: ["text"] }],
    ), normalizeAdvisorConfig({}));

    expect(plan.advisorModel).toBe("openai-codex/gpt-5.5");
    expect(plan.driverModel).toBe("openai-codex/gpt-5.5-mini");
    expect(plan.advisorConfig.model).toBe("openai-codex/gpt-5.5");
  });

  it("allows enable with a strong advisor even when the cheap driver is only a missing recommendation", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-budget-board-strong-only-"));
    try {
      const plan = buildAdvisorBoardProfilePlan(ctx([{ provider: "openai-codex", id: "gpt-5.5", input: ["text"] }]), normalizeAdvisorConfig({}));
      const filePlan = { ...plan, files: { advisor: join(root, "advisor", "config.json") } };

      expect(plan.driverModel).toMatch(/no preferred cheap driver/);
      expect(plan.warnings.join("\n")).toMatch(/No preferred cheap driver/);
      expect(() => applyAdvisorBoardProfilePlan(filePlan)).not.toThrow();
      expect(JSON.parse(readFileSync(filePlan.files.advisor, "utf8")).model).toBe("openai-codex/gpt-5.5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes only advisor profile config when explicitly applied", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-budget-board-"));
    try {
      const plan = buildAdvisorBoardProfilePlan(ctx(), normalizeAdvisorConfig({}));
      const filePlan = { ...plan, files: { advisor: join(root, "advisor", "config.json") } };

      const written = applyAdvisorBoardProfilePlan(filePlan);

      expect(written.profile).toBe("budget-board");
      const advisor = JSON.parse(readFileSync(filePlan.files.advisor, "utf8"));
      expect(advisor.profile).toBe("budget-board");
      expect(advisor.mode).toBe("manual");
      expect(advisor.review).toBe("off");
      expect(existsSync(join(root, "config.json"))).toBe(false);
      expect(existsSync(join(root, "router", "config.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the pre-profile advisor settings when disabling the profile", () => {
    const before = normalizeAdvisorConfig({ mode: "auto", review: "strict", model: "anthropic/claude-opus-4-6", board: { mode: "off" } });
    const enabled = buildAdvisorBoardProfilePlan(ctx(), before).advisorConfig;

    const disabled = disableAdvisorBoardProfile(enabled);

    expect(disabled.profile).toBeUndefined();
    expect(disabled.profileRestore).toBeUndefined();
    expect(disabled.mode).toBe("auto");
    expect(disabled.review).toBe("strict");
    expect(disabled.model).toBe("anthropic/claude-opus-4-6");
    expect(disabled.board).toEqual({ mode: "off" });
    expect(disabled.headOfBoard.mode).toBe("off");
  });

  it("preserves user mode changes made while the profile is active", () => {
    const enabled = buildAdvisorBoardProfilePlan(ctx(), normalizeAdvisorConfig({})).advisorConfig;
    const disabled = disableAdvisorBoardProfile({ ...enabled, mode: "off" });

    expect(disabled.mode).toBe("off");
    expect(disabled.review).toBe("light");
    expect(disabled.profile).toBeUndefined();
  });

  it("preserves advisor model changes made while the profile is active", () => {
    const enabled = buildAdvisorBoardProfilePlan(ctx(), normalizeAdvisorConfig({ model: "anthropic/claude-opus-4-6" })).advisorConfig;
    const disabled = disableAdvisorBoardProfile({ ...enabled, model: "anthropic/claude-sonnet-4-6" });

    expect(disabled.profile).toBeUndefined();
    expect(disabled.model).toBe("anthropic/claude-sonnet-4-6");
    expect(disabled.review).toBe("light");
  });

  it("is a no-op when the profile is already off", () => {
    const cfg = normalizeAdvisorConfig({ mode: "manual", review: "strict", model: "anthropic/claude-opus-4-6", board: { mode: "shadow" } });
    const disabled = disableAdvisorBoardProfile(cfg);

    expect(disabled).toEqual(cfg);
  });

  it("disables legacy profile config without dropping the advisor model override", () => {
    const cfg = normalizeAdvisorConfig({ profile: "budget-board", model: "openai-codex/gpt-5.5", board: { mode: "shadow" }, headOfBoard: { mode: "enabled" } as any });
    const disabled = disableAdvisorBoardProfile(cfg);

    expect(disabled.profile).toBeUndefined();
    expect(disabled.model).toBe("openai-codex/gpt-5.5");
    expect(disabled.mode).toBe("auto");
    expect(disabled.review).toBe("light");
    expect(disabled.checkins).toBe("off");
    expect(disabled.board).toEqual({ mode: "off" });
    expect(disabled.headOfBoard.mode).toBe("off");
    expect(disabled.specialistDispatch.mode).toBe("suggest");
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

describe("review output schema parsing", () => {
  it("parses normal task correction payload and normalizes task actions", () => {
    const parsed = parseReviewPayload(JSON.stringify({
      task: "restore advisor task preservation",
      verdict: "course_correct",
      task_actions: ["Keep task focused on active objective", "Add routing guardrail"],
      advisory_signals: ["Model can still benefit from extra check on pivot severity"],
      pivot: { recommended: true, blocking: false, rationale: "Could be optimized to a smaller model for throughput" },
      summary: "Task still needs focus guard.",
      reason: "Focus drift risk",
    }), "active fallback task");

    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe("course_correct");
    expect(parsed?.activeTask).toBe("restore advisor task preservation");
    expect(parsed?.taskActions).toEqual(["Keep task focused on active objective", "Add routing guardrail"]);
    expect(parsed?.advisorySignals).toEqual(["Model can still benefit from extra check on pivot severity"]);
    expect(parsed?.pivot.blocking).toBe(false);
  });

  it("parses advisory-only signals without task actions", () => {
    const parsed = parseReviewPayload(JSON.stringify({
      task: "complete review loop",
      verdict: "course_correct",
      task_actions: [],
      advisory_signals: ["HF token rotation mention in history is non-actionable here"],
      pivot: { recommended: true, blocking: false, rationale: "None" },
      summary: "No action items",
      reason: "Advisory",
    }), "active fallback task");

    expect(parsed?.taskActions).toEqual([]);
    expect(parsed?.advisorySignals).toEqual(["HF token rotation mention in history is non-actionable here"]);
    expect(parsed?.pivot.recommended).toBe(true);
    expect(parsed?.pivot.blocking).toBe(false);
  });

  it("flags blocking pivots only for strict risk reasons", () => {
    const parsed = parseReviewPayload(JSON.stringify({
      task: "complete review loop",
      verdict: "course_correct",
      task_actions: ["Adjust checks"],
      pivot: {
        recommended: true,
        blocking: true,
        rationale: "Security/data loss risk: requested to skip token rotation cleanup while secrets are unchanged",
      },
    }), "active fallback task");

    expect(parsed?.pivot.recommended).toBe(true);
    expect(parsed?.pivot.blocking).toBe(true);
  });

  it("keeps non-blocking pivots advisory", () => {
    const parsed = parseReviewPayload(JSON.stringify({
      task: "complete review loop",
      verdict: "course_correct",
      task_actions: ["Adjust checks"],
      pivot: {
        recommended: true,
        blocking: false,
        rationale: "Could switch to a smaller model for faster iteration",
      },
    }), "active fallback task");

    expect(parsed?.pivot.recommended).toBe(true);
    expect(parsed?.pivot.blocking).toBe(false);
  });

  it("stale task-change helper aligns follow-up only with matching task", () => {
    const oldDiagnostics = process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH;
    const diagnosticsDir = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-diagnostics-"));
    process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH = join(diagnosticsDir, "diagnostics.jsonl");
    try {
      const nextTask = "run advisor review on original task";
      const staleState = {
        followUp: "run focused check",
        followUpTask: "run advisor review on original task",
        reviewSignals: [],
        reviewSignalsTask: undefined,
      } as any;
      expect(consumeTaskScopedFollowUp(staleState, nextTask)).toBe("run focused check");
      expect(staleState.followUp).toBe("");

      const driftState = {
        followUp: "run focused check",
        followUpTask: "rotate hf token for benchmark credentials",
        reviewSignals: ["old signal"],
        reviewSignalsTask: "rotate hf token for benchmark credentials",
      } as any;
      expect(consumeTaskScopedFollowUp(driftState, nextTask)).toBe("");
      expect(driftState.followUp).toBe("");
      expect(isTaskContinuation("run advisor review on original task", "rotate hf token for benchmark credentials")).toBe(false);
      expect(isTaskContinuation("fix", "fix the auth token bug")).toBe(false);
      expect(isTaskContinuation("failing tests", "fix failing tests")).toBe(true);
      expect(isTaskContinuation("fix auth token bug", "fix auth token bug in package advisor by updating env parsing")).toBe(true);
      expect(isTaskContinuation("investigate failing tests", "fix failing tests")).toBe(true);
      expect(isTaskContinuation("fix auth token bug", "fix ui bug")).toBe(false);
      expect(isTaskContinuation("fix auth token bug", "rotate auth token for benchmark credentials")).toBe(false);

      const legacyState = {
        followUp: "old unscoped follow-up",
        followUpTask: undefined,
        reviewSignals: [],
        reviewSignalsTask: undefined,
      } as any;
      expect(consumeTaskScopedFollowUp(legacyState, nextTask)).toBe("");
      expect(legacyState.followUp).toBe("");
    } finally {
      if (oldDiagnostics === undefined) delete process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH;
      else process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH = oldDiagnostics;
      rmSync(diagnosticsDir, { recursive: true, force: true });
    }
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


describe("Pi-Rogue posture presets", () => {
  function withHome<T>(fn: (home: string) => T): T {
    const oldHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-posture-home-"));
    process.env.HOME = home;
    try {
      return fn(home);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  }

  async function withHomeAsync<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const oldHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-posture-home-"));
    process.env.HOME = home;
    try {
      return await fn(home);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  }

  function postureOptions(home: string) {
    return { advisorPath: join(home, ".pi", "agent", "pi-rogue", "advisor", "config.json") };
  }

  function postureCtx(models: Array<{ provider: string; id: string }>, authenticated: Set<string>, authErrors = new Set<string>()) {
    const catalog = models.map((model) => ({ ...model, input: ["text"] }));
    return {
      modelRegistry: {
        find(provider: string, id: string) {
          return catalog.find((model) => model.provider === provider && model.id === id);
        },
        getAvailable() { return catalog; },
        async getApiKeyAndHeaders(model: { provider: string; id: string }) {
          const ref = `${model.provider}/${model.id}`;
          if (authErrors.has(ref)) throw new Error("credential lookup failed");
          return authenticated.has(ref) ? { ok: true, apiKey: `token-${ref}` } : { ok: false };
        },
      },
    };
  }

  it("parses slash and JSON posture inputs", () => {
    expect(parseCfgPostureArgs("posture guarded")).toBe("guarded");
    expect(parseCfgPostureArgs("guarded")).toBe("guarded");
    expect(parseCfgPostureArgs('{"posture":"guarded"}')).toBe("guarded");
    expect(parseCfgPostureArgs("posture wild")).toBeNull();
    expect(parseCfgPostureArgs("{}")).toBeNull();
  });

  it("applies guarded posture idempotently through the shared backend", () => withHome((home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    const plan = {
      posture: "guarded" as const,
      root,
      advisorModel: "openai-codex/gpt-5.5",
      files: {
        summary: join(root, "config.json"),
        advisor: join(root, "advisor", "config.json"),
        router: join(root, "router", "config.json"),
        contextBrokerConfig: join(root, "context-broker", "config.json"),
      },
    };

    const first = applyPiRoguePosturePlan(plan);
    const firstSummaryText = readFileSync(join(root, "config.json"), "utf8");
    const second = applyPiRoguePosturePlan(plan);
    const secondSummaryText = readFileSync(join(root, "config.json"), "utf8");
    const summary = JSON.parse(secondSummaryText);
    const advisor = JSON.parse(readFileSync(join(root, "advisor", "config.json"), "utf8"));
    const router = JSON.parse(readFileSync(join(root, "router", "config.json"), "utf8"));
    const contextConfig = JSON.parse(readFileSync(join(root, "context-broker", "config.json"), "utf8"));

    expect(first.posture).toBe("guarded");
    expect(second.posture).toBe("guarded");
    expect(secondSummaryText).toBe(firstSummaryText);
    expect(summary.posture).toBe("guarded");
    expect(summary.router).toMatchObject({ enabled: false, activeProfile: "spark-smart" });
    expect(summary.fusion).toMatchObject({ enabled: false });
    expect(advisor).toMatchObject({ profile: "budget-board", mode: "auto", review: "light", model: "openai-codex/gpt-5.5", board: { mode: "shadow" } });
    expect(advisor.profileRestore).toMatchObject({ mode: "auto", review: "light", checkins: "off", profileMode: "auto", profileReview: "light" });
    expect(advisor.headOfBoard.mode).toBe("enabled");
    expect(advisor.specialistDispatch).toMatchObject({ mode: "suggest", maxCostTier: "cheap", maxCallsPerSession: 3 });
    expect(router).toMatchObject({ enabled: false, mode: "auto_model", activeProfile: "spark-smart" });
    expect(router.profileOrder[0]).toBe("spark-smart");
    expect(contextConfig.rewriteThresholdBytes).toBe(2048);
    expect(contextConfig.contextLensesEnabled).toBe(true);
  }));

  it("preserves prior advisor settings for profile off restoration", () => withHome((home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    const plan = {
      posture: "guarded" as const,
      root,
      advisorModel: "openai-codex/gpt-5.5",
      files: {
        summary: join(root, "config.json"),
        advisor: join(root, "advisor", "config.json"),
        router: join(root, "router", "config.json"),
        contextBrokerConfig: join(root, "context-broker", "config.json"),
      },
    };
    mkdirSync(join(root, "advisor"), { recursive: true });
    writeFileSync(plan.files.advisor, JSON.stringify(normalizeAdvisorConfig({
      mode: "manual",
      review: "strict",
      model: "anthropic/claude-opus-4-6",
      board: { mode: "off" },
    }), null, 2), "utf8");

    applyPiRoguePosturePlan(plan);
    const advisor = JSON.parse(readFileSync(plan.files.advisor, "utf8"));

    expect(advisor.profileRestore).toMatchObject({
      mode: "manual",
      review: "strict",
      model: "anthropic/claude-opus-4-6",
      profileMode: "auto",
      profileReview: "light",
      board: { mode: "off" },
    });

    const disabled = disableAdvisorBoardProfile(normalizeAdvisorConfig(advisor));
    expect(disabled.profile).toBeUndefined();
    expect(disabled.mode).toBe("manual");
    expect(disabled.review).toBe("strict");
    expect(disabled.model).toBe("anthropic/claude-opus-4-6");
    expect(disabled.board).toEqual({ mode: "off" });
  }));

  it("refreshes profile ownership markers when guarded is applied over active budget-board", () => withHome((home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    const plan = {
      posture: "guarded" as const,
      root,
      advisorModel: "openai-codex/gpt-5.5",
      files: {
        summary: join(root, "config.json"),
        advisor: join(root, "advisor", "config.json"),
        router: join(root, "router", "config.json"),
        contextBrokerConfig: join(root, "context-broker", "config.json"),
      },
    };
    mkdirSync(join(root, "advisor"), { recursive: true });
    writeFileSync(plan.files.advisor, JSON.stringify(normalizeAdvisorConfig({
      profile: "budget-board",
      profileRestore: {
        mode: "manual",
        review: "strict",
        checkins: "off",
        checkinIntervalMinutes: 30,
        model: "anthropic/claude-opus-4-6",
        profileModel: "openai-codex/gpt-5.5",
        profileMode: "manual",
        profileReview: "off",
        profileCheckins: "off",
        board: { mode: "off" },
        headOfBoard: { mode: "off", maxEvidence: 8, maxRisks: 6, maxFailures: 4, maxSubagents: 6, maxTokens: 1200, reasoning: "medium" },
        specialistDispatch: { mode: "suggest", cooldownTurns: 6, maxCallsPerSession: 3, maxCostTier: "cheap", maxTokens: 900 },
      },
      mode: "manual",
      review: "off",
      model: "openai-codex/gpt-5.5",
      board: { mode: "shadow" },
    }), null, 2), "utf8");

    const result = applyPiRoguePosturePlan(plan);
    const disabled = disableAdvisorBoardProfile(result.advisor);

    expect(result.advisor.profileRestore).toMatchObject({ profileMode: "auto", profileReview: "light", profileModel: "openai-codex/gpt-5.5" });
    expect(disabled.mode).toBe("manual");
    expect(disabled.review).toBe("strict");
    expect(disabled.model).toBe("anthropic/claude-opus-4-6");
  }));

  it("preserves user changes made after guarded posture activation", () => withHome((home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    const plan = {
      posture: "guarded" as const,
      root,
      advisorModel: "openai-codex/gpt-5.5",
      files: {
        summary: join(root, "config.json"),
        advisor: join(root, "advisor", "config.json"),
        router: join(root, "router", "config.json"),
        contextBrokerConfig: join(root, "context-broker", "config.json"),
      },
    };

    const result = applyPiRoguePosturePlan(plan);
    const disabled = disableAdvisorBoardProfile({ ...result.advisor, review: "strict" });

    expect(disabled.review).toBe("strict");
    expect(disabled.mode).toBe("auto");
  }));

  it("validates current config before reporting guarded posture", () => {
    const summary = { posture: "guarded", router: { enabled: false, activeProfile: "spark-smart" }, fusion: { enabled: false } };
    const advisor = normalizeAdvisorConfig({
      profile: "budget-board",
      mode: "auto",
      review: "light",
      board: { mode: "shadow" },
      headOfBoard: { mode: "enabled" } as any,
      specialistDispatch: { mode: "suggest", cooldownTurns: 6, maxCallsPerSession: 3, maxCostTier: "cheap", maxTokens: 900 },
    });
    const router = { enabled: false, activeProfile: "spark-smart" };

    expect(isGuardedPostureConfig(summary, advisor, router)).toBe(true);
    expect(isGuardedPostureConfig(summary, { ...advisor, review: "strict" }, router)).toBe(false);
    expect(isGuardedPostureConfig(summary, advisor, { enabled: true, activeProfile: "spark-smart" })).toBe(false);
  });

  it("preserves supported snake_case context-broker settings", () => withHome((home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    const plan = {
      posture: "guarded" as const,
      root,
      advisorModel: "openai-codex/gpt-5.5",
      files: {
        summary: join(root, "config.json"),
        advisor: join(root, "advisor", "config.json"),
        router: join(root, "router", "config.json"),
        contextBrokerConfig: join(root, "context-broker", "config.json"),
      },
    };
    mkdirSync(join(root, "context-broker"), { recursive: true });
    writeFileSync(plan.files.contextBrokerConfig, JSON.stringify({ rewrite_threshold_bytes: 12345, context_lenses_enabled: false }, null, 2), "utf8");

    applyPiRoguePosturePlan(plan);
    const contextConfig = JSON.parse(readFileSync(plan.files.contextBrokerConfig, "utf8"));

    expect(contextConfig.rewrite_threshold_bytes).toBe(12345);
    expect(contextConfig.rewriteThresholdBytes).toBe(12345);
    expect(contextConfig.context_lenses_enabled).toBe(false);
    expect(contextConfig.contextLensesEnabled).toBe(false);
  }));

  it.each([
    ["empty registry", [], new Set<string>()],
    ["catalog-only unauthenticated model", [{ provider: "openai-codex", id: "gpt-5.5" }], new Set<string>()],
    ["local-only model", [{ provider: "llamacpp", id: "qwen-local" }], new Set<string>(["llamacpp/qwen-local"])],
  ])("rejects %s before writing any posture file", async (_name, models, authenticated) => withHomeAsync(async (home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    await expect(applyPiRoguePostureConfig(postureCtx(models, authenticated), { posture: "guarded" }, postureOptions(home))).rejects.toThrow(/requires an authenticated strong advisor model.*no files were changed/i);
    for (const path of [join(root, "config.json"), join(root, "advisor", "config.json"), join(root, "router", "config.json"), join(root, "context-broker", "config.json")]) {
      expect(existsSync(path), path).toBe(false);
    }
  }));

  it("preserves every existing posture file when authentication rejects", async () => withHomeAsync(async (home) => {
    const root = join(home, ".pi", "agent", "pi-rogue");
    const paths = [join(root, "config.json"), join(root, "advisor", "config.json"), join(root, "router", "config.json"), join(root, "context-broker", "config.json")];
    const before = paths.map((path, index) => {
      mkdirSync(dirname(path), { recursive: true });
      const content = JSON.stringify({ marker: `before-${index}` });
      writeFileSync(path, content, "utf8");
      return content;
    });

    await expect(applyPiRoguePostureConfig(postureCtx([], new Set()), { posture: "guarded" }, postureOptions(home))).rejects.toThrow(/no files were changed/i);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  }));

  it("falls through unusable strong candidates and preserves a configured valid strong model", async () => withHomeAsync(async (home) => {
    const models = [
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "anthropic", id: "claude-opus-4-6" },
    ];
    const fallback = await buildPiRoguePosturePlan(postureCtx(models, new Set(["anthropic/claude-opus-4-6"]), new Set(["openai-codex/gpt-5.5"])), "guarded", postureOptions(home));
    expect(fallback.advisorModel).toBe("anthropic/claude-opus-4-6");

    const defaultPreferred = await buildPiRoguePosturePlan(postureCtx(models, new Set(["openai-codex/gpt-5.5", "anthropic/claude-opus-4-6"])), "guarded", postureOptions(home));
    expect(defaultPreferred.advisorModel).toBe("openai-codex/gpt-5.5");

    const advisorPath = join(home, ".pi", "agent", "pi-rogue", "advisor", "config.json");
    mkdirSync(join(home, ".pi", "agent", "pi-rogue", "advisor"), { recursive: true });
    writeFileSync(advisorPath, JSON.stringify({ model: "anthropic/claude-opus-4-6" }), "utf8");
    const configured = await buildPiRoguePosturePlan(postureCtx(models, new Set(["openai-codex/gpt-5.5", "anthropic/claude-opus-4-6"])), "guarded", postureOptions(home));
    expect(configured.advisorModel).toBe("anthropic/claude-opus-4-6");
  }));

  it("applies an authenticated guarded posture idempotently", async () => withHomeAsync(async (home) => {
    const ctx = postureCtx([{ provider: "openai-codex", id: "gpt-5.5" }], new Set(["openai-codex/gpt-5.5"]));
    const first = await applyPiRoguePostureConfig(ctx, { posture: "guarded" }, postureOptions(home));
    const root = join(home, ".pi", "agent", "pi-rogue");
    const paths = [join(root, "config.json"), join(root, "advisor", "config.json"), join(root, "router", "config.json"), join(root, "context-broker", "config.json")];
    const firstFiles = paths.map((path) => readFileSync(path, "utf8"));
    const second = await applyPiRoguePostureConfig(ctx, { posture: "guarded" }, postureOptions(home));
    expect(second.advisor.model).toBe("openai-codex/gpt-5.5");
    expect(second.posture).toBe(first.posture);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(firstFiles);
  }));

  it("rejects unknown posture values before writing config", async () => withHomeAsync(async (home) => {
    const ctx = postureCtx([], new Set());

    await expect(buildPiRoguePosturePlan(ctx, "wild", postureOptions(home))).rejects.toThrow(/unknown posture/);
    expect(existsSync(join(home, ".pi", "agent", "pi-rogue", "config.json"))).toBe(false);
  }));
});

describe("Pi-Rogue configure planning", () => {
  function ctx(cwd: string) {
    return {
      cwd,
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
          { provider: "openai-codex", id: "gpt-5.3-codex-spark", input: ["text"] },
          { provider: "image-only", id: "paint", input: ["image"] },
        ],
      },
    } as any;
  }

  it("derives advisor/router/fusion defaults from available models and recipes", () => {
    const oldHome = process.env.HOME;
    const oldRecipes = process.env.PI_ROGUE_FUSION_RECIPES;
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-configure-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-rogue-configure-cwd-"));
    try {
      process.env.HOME = root;
      delete process.env.PI_ROGUE_FUSION_RECIPES;
      const recipes = join(root, ".pi", "agent", "pi-rogue", "fusion", "recipes.json");
      mkdirSync(join(root, ".pi", "agent", "pi-rogue", "fusion"), { recursive: true });
      writeFileSync(recipes, JSON.stringify({ recipes: [{ id: "gpt55fused-53spark" }] }), "utf8");

      const plan = buildPiRogueConfigurePlan(ctx(cwd));

      expect(plan.mode).toBe("status");
      expect(plan.advisorModel).toBe("openai-codex/gpt-5.5");
      expect(plan.workerModel).toBe("openai-codex/gpt-5.3-codex-spark");
      expect(plan.activeRouterProfile).toBe("fusion-smart");
      expect(plan.smartModel).toBe("fusion/gpt55fused-53spark");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldRecipes === undefined) delete process.env.PI_ROGUE_FUSION_RECIPES;
      else process.env.PI_ROGUE_FUSION_RECIPES = oldRecipes;
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies an explicit plan to only the plan files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-configure-apply-"));
    try {
      const plan = {
        mode: "on" as const,
        root,
        advisorModel: "openai-codex/gpt-5.5",
        workerModel: "openai-codex/gpt-5.3-codex-spark",
        smartModel: "fusion/gpt55fused-53spark",
        activeRouterProfile: "fusion-smart" as const,
        fusionRecipeId: "gpt55fused-53spark",
        files: {
          summary: join(root, "config.json"),
          advisor: join(root, "advisor", "config.json"),
          router: join(root, "router", "config.json"),
          routerCards: join(root, "router", "model-cards.jsonl"),
          fusionRecipes: join(root, "fusion", "recipes.json"),
          contextBroker: join(root, "context-broker", "artifacts.sqlite"),
        },
        warnings: [],
      };

      applyPiRogueConfigurePlan(plan);

      const advisor = JSON.parse(readFileSync(plan.files.advisor, "utf8"));
      expect(advisor.model).toBe("openai-codex/gpt-5.5");
      expect(advisor.mode).toBe("auto");
      expect(advisor.checkins).toBe("mid-hour");
      const router = JSON.parse(readFileSync(plan.files.router, "utf8"));
      expect(router).toMatchObject({ enabled: true, mode: "observe", activeProfile: "fusion-smart" });
      expect(router.profiles["fusion-smart"].smart).toBe("fusion/gpt55fused-53spark");
      expect(readFileSync(plan.files.routerCards, "utf8")).toContain("gpt55fused-53spark");
      expect(existsSync(plan.files.summary)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("SOTA model suggestions", () => {
  it("includes gpt-5.5 as primary option", () => {
    const cfg = normalizeAdvisorConfig({ mode: "auto", review: "light" });
    expect(cfg.model).toBeUndefined(); // model is optional, auto-detect
  });
});
