import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { advisorSessionStatePath, registerAdvisor } from "./extension.js";

const testHome = vi.hoisted(() => `/tmp/pi-rogue-advisor-loop-convergence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    completeSimple: vi.fn(),
  };
});

type Handler = (event: any, ctx: any) => any;

type HandlerMap = Record<string, Handler[]>;
type CommandMap = Record<string, { handler: (args: string, ctx: any) => any }>;
type MessageRendererMap = Record<string, (message: any, options: { expanded?: boolean }, theme: any) => any>;

function makeHandlers() {
  const handlers: HandlerMap = {};
  const commands: CommandMap = {};
  const messageRenderers: MessageRendererMap = {};
  const sendMessage = vi.fn();

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    registerMessageRenderer: (customType: string, renderer: MessageRendererMap[string]) => {
      messageRenderers[customType] = renderer;
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => any }) => {
      commands[name] = command;
    },
    registerTool: vi.fn(),
    sendMessage,
    sendUserMessage: () => undefined,
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
    },
  };

  return { handlers, commands, messageRenderers, pi: pi as any, sendMessage };
}

const ADVISOR_STATE_DIR = join(homedir(), ".pi", "agent", "pi-rogue", "advisor");
const ADVISOR_STATE_PATH = advisorSessionStatePath("session");
const ADVISOR_CONFIG_PATH = join(ADVISOR_STATE_DIR, "config.json");
const ADVISOR_CACHE_PATH = join(ADVISOR_STATE_DIR, "cache.json");
const ADVISOR_CURRENT_PATH = join(dirname(ADVISOR_STATE_PATH), "current.md");

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
  let commands: CommandMap;
  let messageRenderers: MessageRendererMap;
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let completeSimpleMock: ReturnType<typeof vi.fn>;
  let piMock: any;
  let priorState: string | null = null;
  let priorConfig: string | null = null;
  let priorCache: string | null = null;

  beforeEach(() => {
    priorState = existsSync(ADVISOR_STATE_PATH) ? readFileSync(ADVISOR_STATE_PATH, "utf8") : null;
    priorConfig = existsSync(ADVISOR_CONFIG_PATH) ? readFileSync(ADVISOR_CONFIG_PATH, "utf8") : null;
    priorCache = existsSync(ADVISOR_CACHE_PATH) ? readFileSync(ADVISOR_CACHE_PATH, "utf8") : null;

    const setup = makeHandlers();
    handlers = setup.handlers;
    commands = setup.commands;
    messageRenderers = setup.messageRenderers;
    sendMessageMock = setup.sendMessage;
    piMock = setup.pi;

    mkdirSync(dirname(ADVISOR_STATE_PATH), { recursive: true });
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "light", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_CACHE_PATH, "{}", "utf8");
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

    if (priorCache === null) {
      writeFileSync(ADVISOR_CACHE_PATH, "{}", "utf8");
    } else {
      writeFileSync(ADVISOR_CACHE_PATH, priorCache, "utf8");
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

  it("normalizes string actions in advisor handoffs", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    expect(preflight?.length).toBe(1);
    expect(turnEnd?.length).toBe(1);

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdict: "not_done",
          summary: "Closeout is incomplete",
          reason: "Verification is missing",
          actions: "run focused check",
          checklist: [],
          notify: true,
        }),
      }],
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await preflight![0]({ systemPrompt: "SYS", prompt: "Continue the current goal" }, ctx);
    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: "Repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains." },
    }, ctx);

    const state = readAdvisorState();
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(state.followUp).toBe("Closeout is incomplete — run focused check");
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "advisor:llm",
        content: expect.stringContaining("Actions: run focused check"),
        details: expect.objectContaining({ actions: ["run focused check"] }),
      }),
      expect.anything(),
    );
  });

  it("redacts transient clipboard image paths from emitted advisor handoffs", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    const clipboardPath = "/var/folders/fm/rwczdnws5j58x7kbyn3vcx_h0000gn/T/clipboard-2026-06-04-012248-DEE3A154.png";

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdict: "not_done",
          summary: `The visible handoff should not include ${clipboardPath}`,
          reason: `Expanded Ctrl+O output leaks ${clipboardPath}`,
          actions: [`redact ${clipboardPath}`],
          checklist: [],
          notify: true,
        }),
      }],
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await preflight![0]({ systemPrompt: "SYS", prompt: `Continue the current goal ${clipboardPath}` }, ctx);
    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: "Repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains." },
    }, ctx);

    expect(sendMessageMock).toHaveBeenCalled();
    const sent = sendMessageMock.mock.calls[0]?.[0];
    expect(JSON.stringify(sent)).not.toContain(clipboardPath);
    expect(sent.content).toContain("[clipboard image]");
    expect(readAdvisorState().followUp).toContain("[clipboard image]");

    const theme = {
      fg: (_name: string, text: string) => text,
      bg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const expanded = messageRenderers["advisor:llm"](sent, { expanded: true }, theme).render(120).join("\n");
    expect(expanded).toContain("full handoff:");
    expect(expanded).toContain("Advisor verdict: review.");
    expect(expanded).toContain("[clipboard image]");
    expect(expanded).not.toContain(clipboardPath);
  });

  it("suppresses duplicate reason and summary in advisor handoffs", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    const duplicate = "The agent made a safe attempt, but it did not demonstrate that the advisor post-turn review was induced.";

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdict: "not_done",
          reason: duplicate,
          summary: duplicate,
          actions: ["Invoke the real review hook if available."],
          checklist: [],
          notify: true,
        }),
      }],
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await preflight![0]({ systemPrompt: "SYS", prompt: "Continue the current goal" }, ctx);
    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: "Repo-side autoresearch is verified closed. Only optional external rollout/CI smoke remains." },
    }, ctx);

    const sent = sendMessageMock.mock.calls[0]?.[0];
    expect(sent.content).toContain(`Reason: ${duplicate}`);
    expect(sent.content).not.toContain("Summary:");
    expect(sent.details.summary).toBe("");

    const theme = {
      fg: (_name: string, text: string) => text,
      bg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const collapsed = messageRenderers["advisor:llm"](sent, { expanded: false }, theme).render(120).join("\n");
    const expanded = messageRenderers["advisor:llm"](sent, { expanded: true }, theme).render(120).join("\n");
    expect(collapsed).toContain("reason:");
    expect(collapsed).not.toContain("summary:");
    expect(expanded).toContain("Reason:");
    expect(expanded).not.toContain("reason:");
    expect(expanded).not.toContain("Summary:");
  });

  it("renders manual advisor answers as advisor custom messages", async () => {
    expect(commands["pi-rogue-advisor"]).toBeTruthy();

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: "Post-turn review: no merge blockers identified from the session brief.",
      }],
    });

    await commands["pi-rogue-advisor"].handler("should we merge this pr?", ctx);

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "advisor:llm",
        content: "Post-turn review: no merge blockers identified from the session brief.",
        display: true,
        details: expect.objectContaining({
          kind: "answer",
          summary: "Post-turn review: no merge blockers identified from the session brief.",
        }),
      }),
    );
  });

  it("includes broker briefs in manual advisor context when available", async () => {
    expect(commands["pi-rogue-advisor"]).toBeTruthy();
    piMock.__piRogueContextBroker = {
      renderBrief: () => "## Context Broker\nHot:\n- ctx://session/s/tool_output/abc/ctx-1 summary=\"npm test passed\"",
    };
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "Use the broker handle as evidence." }] });

    await commands["pi-rogue-advisor"].handler("should we use broker context", ctx);

    const messages = completeSimpleMock.mock.calls.at(-1)?.[1]?.messages;
    const promptText = JSON.stringify(messages ?? completeSimpleMock.mock.calls.at(-1));
    expect(promptText).toContain("Context broker brief");
    expect(promptText).toContain("ctx://session/s/tool_output/abc/ctx-1");
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

  it("clears prior task context before reviewing an explicit new issue", async () => {
    const preflight = handlers.before_agent_start;
    const agentEnd = handlers.agent_end;
    expect(preflight?.length).toBe(1);
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const stale = readAdvisorState();
    stale.lastTask = "release @fiale-plus/pi-rogue 0.3.13";
    stale.notes = [
      "Release published: npm now shows @fiale-plus/pi-rogue@0.3.13. Installing locally now.",
      "Publish succeeded, but local package still reports 0.3.12 after pi install.",
    ];
    stale.followUp = "Confirm the local pi install now resolves to @fiale-plus/pi-rogue@0.3.13.";
    stale.followUpTask = stale.lastTask;
    stale.reviewSignals = ["The local install initially reported 0.3.12, so verification is task-critical."];
    stale.reviewSignalsTask = stale.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdict: "on_track",
          summary: "Issue 206 assessment is scoped to the new ticket",
          actions: [],
          checklist: [],
          notify: true,
        }),
      }],
    });

    const nextPrompt = await preflight![0]({ systemPrompt: "SYS", prompt: "wdyt on https://github.com/fiale-plus/pi-rogue/issues/206" }, ctx);
    expect(String(nextPrompt?.systemPrompt)).not.toContain("Advisor follow-up");
    expect(String(nextPrompt?.systemPrompt)).not.toContain("0.3.12");
    expect(String(nextPrompt?.systemPrompt)).not.toContain("local pi install");

    const switched = readAdvisorState();
    expect(switched.lastTask).toBe("wdyt on https://github.com/fiale-plus/pi-rogue/issues/206");
    expect(switched.notes).toEqual([]);
    expect(switched.followUp).toBe("");
    expect(switched.reviewSignals).toEqual([]);

    await agentEnd![0]({
      messages: [
        { role: "toolResult", content: "edit tool changed file" },
        { role: "assistant", content: "Issue #206 looks well scoped as a narrow native log/context-lens ticket." },
      ],
    }, ctx);

    const reviewPrompt = JSON.stringify(completeSimpleMock.mock.calls.at(-1)?.[1]?.messages ?? []);
    expect(reviewPrompt).not.toContain("0.3.12");
    expect(reviewPrompt).not.toContain("local package still reports");
    expect(readAdvisorState().followUp).toBe("");
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

  it("persists clean closeout over stale advisor warnings and current note", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    completeSimpleMock.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdict: "on_track",
          summary: "Final tests, typecheck, and Codex review are clean",
          reason: "The previous review warning has been satisfied",
          actions: [],
          checklist: [],
          notify: true,
        }),
      }],
    });

    await handlers.session_start?.[0]?.({}, ctx);

    const staleTask = "fix advisor stale closeout";
    const stale = readAdvisorState();
    stale.lastTask = staleTask;
    stale.followUp = "final Codex review still needs to complete cleanly before closure";
    stale.followUpTask = staleTask;
    stale.reviewSignals = ["Recent context shows prior failed commands, so confirm latest clean test/typecheck results"];
    stale.reviewSignalsTask = staleTask;
    stale.reviewControl = {
      status: "needed",
      pending: true,
      consumed: false,
      running: false,
      lastDecision: "review",
      lastReason: "final review still needed",
    };
    stale.router.review = {
      phase: "closeout",
      label: "not_done",
      confidence: 0.91,
      reason: "final review still needed",
      source: "llm",
      review: "strict",
      escalate: true,
      trajectory: { failed: true },
    };
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: final review still needed]\n", "utf8");

    await agentEnd![0]({
      messages: [
        { role: "toolResult", content: "edit tool changed file" },
        { role: "assistant", content: "Revalidated clean: tests passed, typecheck passed, and final Codex review had no findings." },
      ],
    }, ctx);

    const resolved = readAdvisorState();
    const current = readFileSync(ADVISOR_CURRENT_PATH, "utf8");
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(resolved.followUp).toBe("");
    expect(resolved.followUpTask).toBeUndefined();
    expect(resolved.reviewSignals).toEqual([]);
    expect(resolved.reviewSignalsTask).toBeUndefined();
    expect(resolved.reviewControl.lastDecision).toBe("continue");
    expect(resolved.reviewControl.status).toBe("consumed");
    expect(current).toContain("advisor:llm: continue");
    expect(current).not.toContain("final review still needed");
    expect(JSON.stringify(resolved.router.review ?? {})).not.toContain('"failed":true');
  });

  it("clears stale advisor warnings for clean closeout without material changes", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const staleTask = "fix advisor stale closeout";
    const stale = readAdvisorState();
    stale.lastTask = staleTask;
    stale.followUp = "final Codex review still needs to complete cleanly before closure";
    stale.followUpTask = staleTask;
    stale.reviewSignals = ["Recent context shows prior failed commands, so confirm latest clean test/typecheck results"];
    stale.reviewSignalsTask = staleTask;
    stale.router.review = {
      phase: "closeout",
      label: "not_done",
      confidence: 0.91,
      reason: "final review still needed",
      source: "llm",
      review: "strict",
      escalate: true,
      trajectory: { failed: true },
    };
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: final review still needed]\n", "utf8");

    await agentEnd![0]({
      messages: [
        { role: "assistant", content: "Final Codex review had no findings; no changes needed." },
      ],
    }, ctx);

    const resolved = readAdvisorState();
    const current = readFileSync(ADVISOR_CURRENT_PATH, "utf8");
    expect(resolved.followUp).toBe("");
    expect(resolved.reviewSignals).toEqual([]);
    expect(resolved.reviewControl.lastDecision).toBe("continue");
    expect(current).toContain("advisor:llm: continue");
    expect(current).not.toContain("final review still needed");
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
