import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { registerAdvisor } from "./extension.js";

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    completeSimple: vi.fn(),
  };
});

type Handler = (event: any, ctx: any) => any;

type HandlerMap = Record<string, Handler[]>;

function makeHandlers() {
  const handlers: HandlerMap = {};
  const sendMessage = vi.fn();

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    registerMessageRenderer: () => undefined,
    registerCommand: () => undefined,
    registerTool: vi.fn(),
    sendMessage,
    sendUserMessage: () => undefined,
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
    },
  };

  return { handlers, pi: pi as any, sendMessage };
}

const ADVISOR_STATE_DIR = join(homedir(), ".pi", "agent", "pi-rogue", "advisor");
const ADVISOR_STATE_PATH = join(ADVISOR_STATE_DIR, "state.json");
const ADVISOR_CONFIG_PATH = join(ADVISOR_STATE_DIR, "config.json");

function readAdvisorState(): any {
  return JSON.parse(readFileSync(ADVISOR_STATE_PATH, "utf8"));
}

function mkCtx() {
  return {
    sessionManager: {
      getSessionFile: () => join(homedir(), ".pi", "agent", "pi-rogue", "advisor", "session.jsonl"),
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
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
    },
  } as any;
}

describe("advisor two-agent convergence", () => {
  let ctx: any;
  let handlers: HandlerMap;
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let completeSimpleMock: ReturnType<typeof vi.fn>;
  let priorState: string | null = null;
  let priorConfig: string | null = null;

  beforeEach(() => {
    priorState = existsSync(ADVISOR_STATE_PATH) ? readFileSync(ADVISOR_STATE_PATH, "utf8") : null;
    priorConfig = existsSync(ADVISOR_CONFIG_PATH) ? readFileSync(ADVISOR_CONFIG_PATH, "utf8") : null;

    const setup = makeHandlers();
    handlers = setup.handlers;
    sendMessageMock = setup.sendMessage;

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
      reviewControl: {
        status: "idle",
        pending: false,
        consumed: true,
        running: false,
      },
    }, null, 2), "utf8");

    registerAdvisor(setup.pi);

    ctx = mkCtx();
    completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();

    const verdict = {
      verdict: "not_done",
      summary: "Closeout is incomplete",
      reason: "Please run one concrete check and report the result",
      actions: ["run focused check"],
      checklist: [],
      notify: true,
    };
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(verdict) }] });
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

  it("does not re-run advisory review on repeated material snapshots", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    expect(preflight?.length).toBe(1);
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const basePrompt = "Continue the current goal";
    const statusText = "Repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains.";

    const firstPrompt = await preflight![0]({ systemPrompt: "SYS", prompt: basePrompt }, ctx);
    expect(typeof firstPrompt).toBe("object");

    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: statusText },
    }, ctx);

    const firstState = readAdvisorState();
    expect(firstState.reviewControl.lastDecision).toBe("review");
    expect(firstState.followUp).toContain("Closeout is incomplete");
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "advisor:llm",
        content: expect.stringContaining("Summary: Closeout is incomplete"),
      }),
      expect.anything(),
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Actions: run focused check") }),
      expect.anything(),
    );
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);

    const consumedPrompt = await preflight![0]({ systemPrompt: "SYS", prompt: basePrompt }, ctx);
    expect(String(consumedPrompt?.systemPrompt)).toContain("Advisor follow-up");

    const consumedState = readAdvisorState();
    expect(consumedState.reviewControl.status).toBe("consumed");
    expect(consumedState.followUp).toBe("");

    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: statusText },
    }, ctx);

    const secondState = readAdvisorState();
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(secondState.reviewControl.status).toBe("consumed");
    expect(["repeated material snapshot", firstState.reviewControl.lastReason]).toContain(secondState.reviewControl.lastReason);

    const withoutFollowUp = await preflight![0]({ systemPrompt: "SYS", prompt: basePrompt }, ctx);
    expect(String(withoutFollowUp?.systemPrompt)).not.toContain("Advisor follow-up");
  });

  it("does not re-run advisory review on repeated agent-end material snapshots", async () => {
    const preflight = handlers.before_agent_start;
    const agentEnd = handlers.agent_end;
    expect(preflight?.length).toBe(1);
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const basePrompt = "Continue the current goal";
    const statusText = "Repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains.";

    const firstPrompt = await preflight![0]({ systemPrompt: "SYS", prompt: basePrompt }, ctx);
    expect(typeof firstPrompt).toBe("object");

    await agentEnd![0]({
      messages: [
        { role: "assistant", content: statusText },
        { role: "toolResult", content: "edit tool changed file" },
      ],
    }, ctx);

    const firstState = readAdvisorState();
    expect(firstState.reviewControl).toBeTruthy();
    const callsBeforeSecond = completeSimpleMock.mock.calls.length;

    const consumedPrompt = await preflight![0]({ systemPrompt: "SYS", prompt: basePrompt }, ctx);
    if (firstState.followUp) {
      expect(String(consumedPrompt?.systemPrompt)).toContain("Advisor follow-up");
    } else {
      expect(String(consumedPrompt?.systemPrompt)).not.toContain("Advisor follow-up");
    }

    const consumedState = readAdvisorState();
    expect(consumedState.reviewControl.status).toBe("consumed");
    expect(consumedState.followUp).toBe("");

    await agentEnd![0]({
      messages: [
        { role: "assistant", content: statusText },
        { role: "toolResult", content: "edit tool changed file" },
      ],
    }, ctx);

    const secondState = readAdvisorState();
    expect(completeSimpleMock).toHaveBeenCalledTimes(callsBeforeSecond);
    expect(secondState.reviewControl.status).toBe("consumed");
    expect(secondState.reviewControl.lastReason).toBe("repeated material snapshot");

    const withoutFollowUp = await preflight![0]({ systemPrompt: "SYS", prompt: basePrompt }, ctx);
    expect(String(withoutFollowUp?.systemPrompt)).not.toContain("Advisor follow-up");
  });

  it("records on-track reviews silently instead of emitting repetitive continue hints", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    expect(preflight?.length).toBe(1);
    expect(turnEnd?.length).toBe(1);

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdict: "on_track",
          summary: "Implementation aligns with the requested advisor check-in behavior",
          actions: [],
          checklist: [],
          notify: true,
        }),
      }],
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await preflight![0]({ systemPrompt: "SYS", prompt: "Continue the current goal" }, ctx);
    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: "Secret token handling was reviewed and the safety fix is complete." },
    }, ctx);

    const state = readAdvisorState();
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(state.reviewControl.lastDecision).toBe("continue");
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "advisor:llm" }),
      expect.anything(),
    );
  });

  it("recovers running review control state on session start", async () => {
    const preflight = handlers.before_agent_start;
    const sessionStart = handlers.session_start;
    expect(sessionStart?.length).toBe(1);
    expect(preflight?.length).toBe(1);

    const state = readAdvisorState();
    state.reviewControl = {
      status: "running",
      pending: true,
      consumed: false,
      running: true,
      lastMaterialSignature: "stale",
      lastTrigger: "turn-1",
    };
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    await sessionStart![0]({}, ctx);

    const recovered = readAdvisorState();
    expect(recovered.reviewControl.running).toBe(false);
    expect(recovered.reviewControl.status).toBe("needed");
    expect(recovered.reviewControl.pending).toBe(true);
    expect(recovered.reviewControl.consumed).toBe(false);

    const status = await preflight![0]({ systemPrompt: "SYS", prompt: "Continue the current goal" }, ctx);
    expect(status?.systemPrompt).toContain("Review-control: needed");
  });
});
