import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { advisorSessionStatePath, registerAdvisor } from "./extension.js";

const testHome = vi.hoisted(() => `/tmp/pi-rogue-advisor-state-versioning-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return { ...actual, completeSimple: vi.fn() };
});

type Handler = (event: any, ctx: any) => any;
type HandlerMap = Record<string, Handler[]>;
type CommandMap = Record<string, { handler: (args: string, ctx: any) => any }>;

function makeHandlers() {
  const handlers: HandlerMap = {};
  const commands: CommandMap = {};
  const sendMessage = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => { handlers[event] ??= []; handlers[event].push(handler); },
    registerMessageRenderer: () => undefined,
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => any }) => { commands[name] = command; },
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
