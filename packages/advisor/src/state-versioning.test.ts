import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { advisorSessionStatePath, registerAdvisor } from "./extension.js";
import { ADVISOR_CANONICAL_CONTROL_LEAVES } from "./completions.js";

const testHome = vi.hoisted(() => `/tmp/pi-rogue-advisor-state-versioning-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

vi.mock("@earendil-works/pi-ai/compat", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
  return { ...actual, completeSimple: vi.fn() };
});

const completeSimpleMock = vi.mocked(completeSimple);

type Handler = (event: any, ctx: any) => any;
type HandlerMap = Record<string, Handler[]>;
type CommandMap = Record<string, { description?: string; handler: (args: string, ctx: any) => any }>;

function makeHandlers() {
  const handlers: HandlerMap = {};
  const commands: CommandMap = {};
  const sendMessage = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => { handlers[event] ??= []; handlers[event].push(handler); },
    registerMessageRenderer: () => undefined,
    registerCommand: (name: string, command: CommandMap[string]) => { commands[name] = command; },
    registerTool: vi.fn(),
    sendMessage,
    sendUserMessage: () => undefined,
    ui: { setStatus: () => undefined, notify: () => undefined },
  };
  return { handlers, commands, pi: pi as any, sendMessage };
}

const ADVISOR_STATE_DIR = join(homedir(), ".pi", "agent", "pi-rogue", "advisor");
const ADVISOR_CONFIG_PATH = join(ADVISOR_STATE_DIR, "config.json");
const ADVISOR_STATE_PATH = advisorSessionStatePath({
  sessionManager: { getSessionFile: () => join(homedir(), ".pi", "agent", "pi-rogue", "advisor", "session.jsonl") },
});

function readAdvisorState(): any {
  return JSON.parse(readFileSync(ADVISOR_STATE_PATH, "utf8"));
}

function mkCtx(session = "session") {
  return {
    sessionManager: {
      getSessionFile: () => join(homedir(), ".pi", "agent", "pi-rogue", "advisor", `${session}.jsonl`),
    },
    isIdle: () => true,
    modelRegistry: {
      find: (provider: string, model: string) => {
        if (provider === "openai-codex") return { id: `${provider}/${model}`, provider, input: ["text"] };
        return null;
      },
      getAvailable: () => [{ id: "provider/text-light", provider: "provider", input: ["text"] }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    },
    ui: { setStatus: () => undefined, notify: () => undefined },
  } as any;
}

describe("state versioning and recovery", () => {
  let priorState: string | null = null;
  let priorConfig: string | null = null;

  beforeEach(() => {
    priorState = existsSync(ADVISOR_STATE_PATH) ? readFileSync(ADVISOR_STATE_PATH, "utf8") : null;
    priorConfig = existsSync(ADVISOR_CONFIG_PATH) ? readFileSync(ADVISOR_CONFIG_PATH, "utf8") : null;

    const setup = makeHandlers();
    const { handlers, commands, pi } = setup;
    handlers; commands;

    mkdirSync(dirname(ADVISOR_STATE_PATH), { recursive: true });
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "light", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify({
      turns: 0,
      lastTask: "",
      notes: [],
      files: [],
      errors: [],
      advisorCalls: 0,
      cacheHits: 0,
      followUp: "",
      router: {},
      checkin: { queued: false },
      reviewControl: { status: "idle", pending: false, consumed: true, running: false },
    }, null, 2), "utf8");

    registerAdvisor(pi);
  });

  afterEach(() => {
    if (priorState === null) {
      writeFileSync(ADVISOR_STATE_PATH, "{}", "utf8");
    } else {
      writeFileSync(ADVISOR_STATE_PATH, priorState, "utf8");
    }
    if (priorConfig === null) {
      writeFileSync(ADVISOR_CONFIG_PATH, "{}", "utf8");
    } else {
      writeFileSync(ADVISOR_CONFIG_PATH, priorConfig, "utf8");
    }
  });

  it("loads state with version field and preserves existing data", () => {
    // Write a state without _v to simulate old state
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify({
      turns: 0,
      lastTask: "",
      notes: [],
      files: [],
      errors: [],
      advisorCalls: 0,
      cacheHits: 0,
      followUp: "",
      router: {},
      checkin: { queued: false },
      reviewControl: { status: "idle", pending: false, consumed: true, running: false },
    }, null, 2), "utf8");

    // Load state directly (simulates what loadState does)
    const raw = JSON.parse(readFileSync(ADVISOR_STATE_PATH, "utf8"));
    expect(raw._v).toBeUndefined(); // Old state has no _v

    // After loadState + saveState cycle, _v should be present
    const setup = makeHandlers();
    const { handlers: h, pi } = setup;
    registerAdvisor(pi);
    const ctx = mkCtx();
    void h.session_start?.[0]?.({}, ctx);

    const state = JSON.parse(readFileSync(ADVISOR_STATE_PATH, "utf8"));
    // The session_start handler calls loadState() which adds _v, then saveState() writes it
    expect(state._v).toBe(1);
    expect(state.turns).toBe(0);
    expect(state.lastTask).toBe("");
  });

  it("recovers corrupted state gracefully", () => {
    // Write corrupted state
    writeFileSync(ADVISOR_STATE_PATH, "{ corrupted json", "utf8");
    const handlers = makeHandlers();
    const { handlers: h, pi } = handlers;
    registerAdvisor(pi);
    // Loading state should not throw
    const ctx = mkCtx();
    void h.session_start?.[0]?.({}, ctx);
    // State should be recovered to default
    const recovered = readAdvisorState();
    expect(recovered._v).toBe(1);
    expect(recovered.turns).toBe(0);
  });

  it("migrates old state without _v field to current version", () => {
    // Write state without _v field
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify({
      turns: 5,
      lastTask: "old task",
      notes: [],
      files: [],
      errors: [],
      advisorCalls: 3,
      cacheHits: 1,
      followUp: "",
      router: {},
      checkin: { queued: false },
      reviewControl: { status: "idle", pending: false, consumed: true, running: false },
    }, null, 2), "utf8");

    const handlers = makeHandlers();
    const { handlers: h, pi } = handlers;
    registerAdvisor(pi);
    const ctx = mkCtx();
    void h.session_start?.[0]?.({}, ctx);

    const migrated = readAdvisorState();
    expect(migrated._v).toBe(1);
    expect(migrated.turns).toBe(5);
    expect(migrated.lastTask).toBe("old task");
    expect(migrated.advisorCalls).toBe(3);
  });

  it("handles missing state file by creating default", () => {
    writeFileSync(ADVISOR_STATE_PATH, "{}", "utf8");
    const handlers = makeHandlers();
    const { handlers: h, pi } = handlers;
    registerAdvisor(pi);
    const ctx = mkCtx();
    void h.session_start?.[0]?.({}, ctx);

    const loaded = readAdvisorState();
    expect(loaded._v).toBe(1);
    expect(loaded.turns).toBe(0);
    expect(loaded.reviewControl.status).toBe("idle");
  });

  it("preserves reviewControl state across loads", () => {
    const state = readAdvisorState();
    state.reviewControl = {
      status: "needed",
      pending: true,
      consumed: false,
      running: false,
      lastDecision: "review",
      lastMaterialSignature: "test-sig",
      lastReason: "test reason",
      lastTrigger: "turn-1",
      lastAppliedAt: new Date().toISOString(),
    };
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    const handlers = makeHandlers();
    const { handlers: h, pi } = handlers;
    registerAdvisor(pi);
    const ctx = mkCtx();
    void h.session_start?.[0]?.({}, ctx);

    const recovered = readAdvisorState();
    expect(recovered.reviewControl.status).toBe("needed");
    expect(recovered.reviewControl.pending).toBe(true);
    expect(recovered.reviewControl.lastDecision).toBe("review");
  });

  it("advertises the exact canonical control leaves in runtime help", () => {
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    expect(setup.commands["pi-rogue-advisor"].description).toContain(ADVISOR_CANONICAL_CONTROL_LEAVES.join("|"));
  });

  it.each(["CoNfIg", "SeTtInGs"])("keeps %s local and model-free", async (leaf) => {
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    const ctx = mkCtx(`local-${leaf}`);
    const notify = vi.fn();
    ctx.ui.notify = notify;
    completeSimpleMock.mockClear();

    await setup.commands["pi-rogue-advisor"].handler(leaf, ctx);

    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toContain("Advisor config");
  });

  it.each(["manual", "auto", "off"] as const)("converges %s to auto through case-insensitive ON", async (mode) => {
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    const ctx = mkCtx(`on-${mode}`);
    completeSimpleMock.mockClear();
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode, review: "light", checkins: "off", checkinIntervalMinutes: 30 }), "utf8");

    await setup.commands["pi-rogue-advisor"].handler("ON", ctx);

    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(ADVISOR_CONFIG_PATH, "utf8")).mode).toBe("auto");
  });

  it("preserves mixed-case free-form questions after outer trimming", async () => {
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    const ctx = mkCtx("mixed-case");
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "answer" }] } as any);
    const question = "Explain MyHTTPParser at /Tmp/MixedCase.ts";

    await setup.commands["pi-rogue-advisor"].handler(`  ${question}  `, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const request = completeSimpleMock.mock.calls[0]?.[1] as any;
    expect(JSON.stringify(request?.messages)).toContain(question);
    expect(JSON.stringify(request?.messages)).not.toContain(question.toLowerCase());
    expect(setup.sendMessage).toHaveBeenCalled();
  });

  it("releases the review lock after a bounded completion deadline", async () => {
    vi.useFakeTimers();
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    const ctx = mkCtx();
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "strict", checkins: "off", checkinIntervalMinutes: 30 }), "utf8");
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify({
      turns: 1, lastTask: "review lock ownership", notes: ["initial progress"], files: [], errors: [], advisorCalls: 0, cacheHits: 0,
      followUp: "", router: {}, checkin: {}, reviewControl: { status: "idle", pending: false, consumed: true, running: false },
    }), "utf8");
    completeSimpleMock.mockReset();
    completeSimpleMock.mockImplementation(() => new Promise(() => undefined));
    try {
      const first = setup.handlers.turn_end?.[0]?.({ toolResults: [{ toolName: "edit" }], message: { content: [{ type: "text", text: "first review delta" }] } }, ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      await first;

      completeSimpleMock.mockReset();
      completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ verdict: "on_track", reason: "ok", summary: "ok", taskActions: [], advisorySignals: [] }) }] } as any);
      await setup.handlers.turn_end?.[0]?.({ toolResults: [{ toolName: "edit" }], message: { content: [{ type: "text", text: "second distinct review delta" }] } }, ctx);
      expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a rejected detached advisor check-in without another async failure", async () => {
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    const ctx = mkCtx();
    let statusCalls = 0;
    ctx.ui.setStatus = () => {
      statusCalls += 1;
      if (statusCalls === 2) throw new Error("check-in status failure");
    };
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "light", checkins: "mid-hour", checkinIntervalMinutes: 30, checkinStartedAt: Date.now() - 31 * 60_000 }), "utf8");
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify({
      turns: 0, lastTask: "keep check-ins contained", notes: ["progress"], files: [], errors: [], advisorCalls: 0, cacheHits: 0,
      followUp: "", router: {}, checkin: { lastTurn: 0 }, reviewControl: { status: "idle", pending: false, consumed: true, running: false },
    }), "utf8");
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "Status: on_track - ok\nNudge: continue" }] } as any);
    const diagnostics = join(testHome, "detached-checkin.jsonl");
    const previousDiagnostics = process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH;
    process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH = diagnostics;
    try {
      await setup.handlers.turn_end?.[0]?.({ toolResults: [], message: { content: [{ type: "text", text: "done" }] } }, ctx);
      await vi.waitFor(() => {
        expect(readFileSync(diagnostics, "utf8")).toContain("advisor_checkin_detached_failure");
      });
    } finally {
      if (previousDiagnostics === undefined) delete process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH;
      else process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH = previousDiagnostics;
    }
  });

  it("does not let a shutdown continuation start a review or check-in, then reopens on session start", async () => {
    const setup = makeHandlers();
    registerAdvisor(setup.pi);
    const ctx = mkCtx("shutdown-race-stable-session");
    const sessionStatePath = advisorSessionStatePath(ctx);
    mkdirSync(dirname(sessionStatePath), { recursive: true });
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({
      mode: "auto", review: "strict", checkins: "mid-hour", checkinIntervalMinutes: 10,
      checkinStartedAt: Date.now() - 11 * 60_000,
    }), "utf8");
    writeFileSync(sessionStatePath, JSON.stringify({
      turns: 0, lastTask: "preserve shutdown ownership", notes: ["review this change"], files: [], errors: [], advisorCalls: 0, cacheHits: 0,
      followUp: "", router: {}, checkin: { lastTurn: 0 }, reviewControl: { status: "idle", pending: false, consumed: true, running: false },
    }), "utf8");
    completeSimpleMock.mockReset();
    completeSimpleMock.mockImplementation(() => new Promise(() => undefined));

    const first = setup.handlers.turn_end?.[0]?.({
      toolResults: [{ toolName: "edit" }],
      message: { content: [{ type: "text", text: "first review race delta" }] },
    }, ctx);
    await vi.waitFor(() => expect(completeSimpleMock).toHaveBeenCalledTimes(1));
    setup.handlers.session_shutdown?.[0]?.({}, ctx);
    await first;

    // The continuation after the aborted review reaches the check-in path, but it
    // must not launch another completion. New post-shutdown events are also inert.
    await setup.handlers.turn_end?.[0]?.({
      toolResults: [{ toolName: "edit" }],
      message: { content: [{ type: "text", text: "post-shutdown review delta" }] },
    }, ctx);
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);

    // A resumed/reloaded session uses the same stable identity and explicitly reopens it.
    setup.handlers.session_start?.[0]?.({}, ctx);
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "strict", checkins: "off", checkinIntervalMinutes: 10 }), "utf8");
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ verdict: "on_track", reason: "ok", summary: "ok", taskActions: [], advisorySignals: [] }) }] } as any);
    await setup.handlers.turn_end?.[0]?.({
      toolResults: [{ toolName: "edit" }],
      message: { content: [{ type: "text", text: "resumed review delta" }] },
    }, ctx);
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
  });

  it("keeps mutable advisor state isolated by session", async () => {
    const setup = makeHandlers();
    const { handlers: h, pi } = setup;
    registerAdvisor(pi);

    const ctxA = mkCtx("model-training");
    const ctxB = mkCtx("runpod");

    void h.session_start?.[0]?.({}, ctxA);
    await h.before_agent_start?.[0]?.({ prompt: "train advisor on regex logs", systemPrompt: "base" }, ctxA);

    const stateA = JSON.parse(readFileSync(advisorSessionStatePath(ctxA), "utf8"));
    expect(stateA.lastTask).toBe("train advisor on regex logs");

    void h.session_start?.[0]?.({}, ctxB);
    const stateB = JSON.parse(readFileSync(advisorSessionStatePath(ctxB), "utf8"));
    expect(stateB.lastTask).toBe("");
    expect(stateB.followUp).toBe("");
    expect(stateB.reviewSignals).toEqual([]);
  });
});
