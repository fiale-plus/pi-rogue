import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { advisorSessionStatePath, registerAdvisor } from "./extension.js";
import * as advisorRouter from "./router.js";

const testHome = vi.hoisted(() => `/tmp/pi-rogue-advisor-loop-convergence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

vi.mock("@earendil-works/pi-ai/compat", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
  return {
    ...actual,
    completeSimple: vi.fn(),
  };
});

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

type Handler = (event: any, ctx: any) => any;

type HandlerMap = Record<string, Handler[]>;
type CommandMap = Record<string, { handler: (args: string, ctx: any) => any }>;
type ToolMap = Record<string, { execute: (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => any }>;
type MessageRendererMap = Record<string, (message: any, options: { expanded?: boolean }, theme: any) => any>;

function makeHandlers() {
  const handlers: HandlerMap = {};
  const commands: CommandMap = {};
  const tools: ToolMap = {};
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
    registerTool: (tool: { name: string; execute: ToolMap[string]["execute"] }) => {
      tools[tool.name] = tool;
    },
    sendMessage,
    sendUserMessage: () => undefined,
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
    },
  };

  return { handlers, commands, tools, messageRenderers, pi: pi as any, sendMessage };
}

const ADVISOR_STATE_DIR = join(homedir(), ".pi", "agent", "pi-rogue", "advisor");
const ADVISOR_STATE_PATH = advisorSessionStatePath({
  sessionManager: { getSessionFile: () => join(homedir(), ".pi", "agent", "pi-rogue", "advisor", "session.jsonl") },
});
const ADVISOR_CONFIG_PATH = join(ADVISOR_STATE_DIR, "config.json");
const ADVISOR_CACHE_PATH = join(ADVISOR_STATE_DIR, "cache.json");
const ADVISOR_DIAGNOSTICS_PATH = join(ADVISOR_STATE_DIR, "diagnostics.jsonl");
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
  let tools: ToolMap;
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
    tools = setup.tools;
    messageRenderers = setup.messageRenderers;
    sendMessageMock = setup.sendMessage;
    piMock = setup.pi;

    mkdirSync(dirname(ADVISOR_STATE_PATH), { recursive: true });
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "light", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_CACHE_PATH, "{}", "utf8");
    writeFileSync(ADVISOR_DIAGNOSTICS_PATH, "", "utf8");
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
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return "test-sha\n";
      if (command === "gh" && args.join(" ") === "pr view 215 --json state,mergeCommit") {
        return JSON.stringify({ state: "MERGED", mergeCommit: { oid: "merged-sha" } });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

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

  it("does re-run repeated failed snapshots instead of suppressing safety-critical review", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const state = readAdvisorState();
    state.lastTask = "fix failing tests";
    state.turns = 1;
    state.notes = ["validation is failing"];
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    const failureEvent = {
      messages: [
        { role: "assistant", content: "npm test failed" },
        { role: "toolResult", status: "error", error: "npm test failed", content: "npm test failed" },
      ],
    };

    await agentEnd![0](failureEvent, ctx);
    await agentEnd![0](failureEvent, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(readAdvisorState().reviewControl.lastReason).not.toBe("repeated material snapshot");
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

  it("keys manual answers by normalized scope and every prompt-affecting option", async () => {
    completeSimpleMock
      .mockResolvedValueOnce({ content: [{ type: "text", text: "architecture answer" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "security answer" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "security answer with recent work" }] });
    const signal = new AbortController().signal;
    const ask = (scope: string, includeRecentWork: boolean) => tools.advisor.execute(
      "advisor-cache-test",
      { question: "Choose the boundary", scope, includeRecentWork },
      signal,
      undefined,
      ctx,
    );

    const architecture = await ask(" Architecture ", false);
    const security = await ask("security", false);
    const cachedSecurity = await ask(" SECURITY ", false);
    const withRecentWork = await ask("security", true);
    const cachedWithRecentWork = await ask("security", true);

    expect(architecture.content[0].text).toBe("architecture answer");
    expect(security.content[0].text).toBe("security answer");
    expect(cachedSecurity.details.cached).toBe(true);
    expect(withRecentWork.content[0].text).toBe("security answer with recent work");
    expect(cachedWithRecentWork.details.cached).toBe(true);
    expect(completeSimpleMock).toHaveBeenCalledTimes(3);
  });

  it("ignores cache entries written under the legacy unscoped identity", async () => {
    const question = "Should this boundary move?";
    const legacyKey = createHash("sha256")
      .update(["adv", "auto", question, "", ""].join("||"))
      .digest("hex")
      .slice(0, 16);
    writeFileSync(ADVISOR_CACHE_PATH, JSON.stringify({ [legacyKey]: "legacy unscoped answer" }), "utf8");
    completeSimpleMock.mockResolvedValueOnce({ content: [{ type: "text", text: "fresh scoped answer" }] });

    const result = await tools.advisor.execute(
      "legacy-cache-test",
      { question, scope: "architecture", includeRecentWork: false },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toBe("fresh scoped answer");
    expect(result.details.cached).not.toBe(true);
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
  });

  it("keeps delimiter-adversarial request tuples distinct", async () => {
    completeSimpleMock
      .mockResolvedValueOnce({ content: [{ type: "text", text: "first tuple" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "second tuple" }] });
    const signal = new AbortController().signal;

    const first = await tools.advisor.execute("delimiter-a", { question: "a||b", scope: "c", includeRecentWork: false }, signal, undefined, ctx);
    const second = await tools.advisor.execute("delimiter-b", { question: "a", scope: "b||c", includeRecentWork: false }, signal, undefined, ctx);

    expect(first.content[0].text).toBe("first tuple");
    expect(second.content[0].text).toBe("second tuple");
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
  });

  it("hashes the complete question instead of colliding on a shared prefix", async () => {
    const prefix = "x".repeat(310);
    completeSimpleMock
      .mockResolvedValueOnce({ content: [{ type: "text", text: "tail A answer" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "tail B answer" }] });
    const signal = new AbortController().signal;

    const first = await tools.advisor.execute("question-a", { question: `${prefix}A`, scope: "planning", includeRecentWork: false }, signal, undefined, ctx);
    const second = await tools.advisor.execute("question-b", { question: `${prefix}B`, scope: "planning", includeRecentWork: false }, signal, undefined, ctx);

    expect(first.content[0].text).toBe("tail A answer");
    expect(second.content[0].text).toBe("tail B answer");
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
  });

  it("emits one controlled failure only after every auth candidate is exhausted", async () => {
    const attempted: string[] = [];
    ctx.ui.notify = vi.fn();
    ctx.modelRegistry.getApiKeyAndHeaders = async (model: any) => {
      attempted.push(`${model.provider}/${model.id}`);
      throw new Error("credential lookup failed with secret=sk-sensitive-token-value");
    };

    await commands["pi-rogue-advisor"].handler("can an advisor answer this?", ctx);

    expect(attempted).toEqual([
      "openai-codex/openai-codex/gpt-5.5",
      "openai-codex/openai-codex/gpt-5.4-mini",
      "provider/provider/text-light",
    ]);
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No model available. Install one via pi config.", "warning");
    expect(readFileSync(ADVISOR_DIAGNOSTICS_PATH, "utf8")).not.toContain("sensitive-token-value");
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

  it("detects repetitive advisory answers when the context changes", async () => {
    expect(commands["pi-rogue-advisor"]).toBeTruthy();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "Keep the current approach and inspect the latest brief." }],
    });

    const bumpContext = (label: string) => {
      const next = readAdvisorState();
      next.turns = (next.turns ?? 0) + 1;
      next.lastTask = "same underlying task";
      next.notes = [...(next.notes ?? []), `context ${label}`];
      writeFileSync(ADVISOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    };

    bumpContext("first");
    await commands["pi-rogue-advisor"].handler("should I keep going?", ctx);
    bumpContext("second");
    await commands["pi-rogue-advisor"].handler("should I keep going?", ctx);
    bumpContext("third");
    await commands["pi-rogue-advisor"].handler("should I keep going?", ctx);

    const lastMessage = sendMessageMock.mock.calls.at(-1)?.[0];
    expect(String(lastMessage?.content)).toContain("Advisor loop detected");
    expect(String(lastMessage?.content)).not.toContain("Keep the current approach");
    expect(readFileSync(ADVISOR_DIAGNOSTICS_PATH, "utf8")).toContain("advisor_loop_detected");
    expect(completeSimpleMock).toHaveBeenCalledTimes(3);
  });

  it("does not carry manual loop detection across unrelated tasks", async () => {
    expect(commands["pi-rogue-advisor"]).toBeTruthy();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "Use the latest evidence and run one focused check." }],
    });

    for (const task of ["fix advisor loop guard", "rotate hf token", "repair context broker cache"]) {
      const next = readAdvisorState();
      next.turns = (next.turns ?? 0) + 1;
      next.lastTask = task;
      next.notes = [...(next.notes ?? []), `working on ${task}`];
      writeFileSync(ADVISOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await commands["pi-rogue-advisor"].handler("should I keep going?", ctx);
    }

    const lastMessage = sendMessageMock.mock.calls.at(-1)?.[0];
    expect(String(lastMessage?.content)).not.toContain("Advisor loop detected");
  });

  it("detects oscillating repetitive advisory answers", async () => {
    expect(commands["pi-rogue-advisor"]).toBeTruthy();
    completeSimpleMock
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Advice A: inspect the latest brief before continuing." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Advice B: run one focused validation before continuing." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Advice A - inspect the latest brief before continuing." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Advice B - run one focused validation before continuing." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Advice A: inspect the latest brief before continuing." }] });

    for (const label of ["one", "two", "three", "four", "five"]) {
      const next = readAdvisorState();
      next.turns = (next.turns ?? 0) + 1;
      next.lastTask = "same underlying task";
      next.notes = [...(next.notes ?? []), `context ${label}`];
      writeFileSync(ADVISOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await commands["pi-rogue-advisor"].handler("should I keep going?", ctx);
    }

    const lastMessage = sendMessageMock.mock.calls.at(-1)?.[0];
    expect(String(lastMessage?.content)).toContain("Advisor loop detected");
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

  it("does not reset task context for generic same-issue continuation wording", async () => {
    const preflight = handlers.before_agent_start;
    expect(preflight?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const state = readAdvisorState();
    state.lastTask = "fix the failing install issue";
    state.notes = ["Local install still needs verification after npm publish."];
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    await preflight![0]({ systemPrompt: "SYS", prompt: "check out the issue with the failing install" }, ctx);

    expect(readAdvisorState().notes).toEqual(["Local install still needs verification after npm publish."]);
  });

  it("resets stale task context on explicit different issue id", async () => {
    const preflight = handlers.before_agent_start;
    expect(preflight?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const state = readAdvisorState();
    state.lastTask = "wdyt on issue #20";
    state.notes = ["Issue #20 requested follow-up checks on npm tags."];
    state.followUp = "Issue #20 follow-up still requires action.";
    state.followUpTask = state.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    await preflight![0]({ systemPrompt: "SYS", prompt: "wdyt on #206" }, ctx);

    expect(readAdvisorState().notes).toEqual([]);
    expect(readAdvisorState().followUp).toBe("");
    expect(readAdvisorState().followUpTask).toBeUndefined();
  });

  it("resets when same issue number appears in different repositories", async () => {
    const preflight = handlers.before_agent_start;
    expect(preflight?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const state = readAdvisorState();
    state.lastTask = "wdyt on https://github.com/fiale-plus/pi-rogue/issues/206";
    state.notes = ["Issue #206 in pi-rogue still needs local install verification."];
    state.followUp = "Check local install status for this repository.";
    state.followUpTask = state.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    await preflight![0]({ systemPrompt: "SYS", prompt: "Check https://github.com/fiale-plus/pi-rogue-orchestration/issues/206" }, ctx);

    expect(readAdvisorState().notes).toEqual([]);
    expect(readAdvisorState().followUp).toBe("");
    expect(readAdvisorState().followUpTask).toBeUndefined();
  });

  it("keeps context when issue id wording stays the same", async () => {
    const preflight = handlers.before_agent_start;
    expect(preflight?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const state = readAdvisorState();
    state.lastTask = "fix issue 206 in the release flow";
    state.notes = ["Issue 206 needs extra verification in install step."];
    state.followUp = "Follow-up: confirm npm install now points to local package.";
    state.followUpTask = state.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    const preflightPrompt = await preflight![0]({ systemPrompt: "SYS", prompt: "continue #206" }, ctx);

    expect(readAdvisorState().notes).toEqual(["Issue 206 needs extra verification in install step."]);
    expect(String(preflightPrompt?.systemPrompt)).toContain("Follow-up: confirm npm install now points to local package.");
  });

  it("keeps context when bare issue wording becomes explicit URL", async () => {
    const preflight = handlers.before_agent_start;
    expect(preflight?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const state = readAdvisorState();
    state.lastTask = "review issue 206";
    state.notes = ["Issue 206 still has verification pending."];
    state.followUp = "Follow-up: check badge status for issue 206";
    state.followUpTask = state.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(state, null, 2), "utf8");

    const preflightPrompt = await preflight![0]({
      systemPrompt: "SYS",
      prompt: "Please re-check https://github.com/fiale-plus/pi-rogue/issues/206",
    }, ctx);

    expect(readAdvisorState().notes).toEqual(["Issue 206 still has verification pending."]);
    expect(String(preflightPrompt?.systemPrompt)).toContain("Follow-up: check badge status for issue 206");
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
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(resolved.followUp).toBe("");
    expect(resolved.followUpTask).toBeUndefined();
    expect(resolved.reviewSignals).toEqual([]);
    expect(resolved.reviewSignalsTask).toBeUndefined();
    expect(resolved.reviewControl.lastDecision).toBe("continue");
    expect(resolved.reviewControl.status).toBe("consumed");
    expect(resolved.workflow?.terminal).toMatchObject({ state: "green", sha: "test-sha", source: "agent-end" });
    expect(current).toContain("advisor:llm: continue");
    expect(current).not.toContain("final review still needed");
    expect(JSON.stringify(resolved.router.review ?? {})).not.toContain('"failed":true');
  });

  it("clears stale failing-test advisor warnings when terminal machine evidence is green", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const staleTask = "merge PR #215 after context-broker validation";
    const stale = readAdvisorState();
    stale.lastTask = staleTask;
    stale.followUp = "targeted context-broker vitest runs are still failing and need resolution";
    stale.followUpTask = staleTask;
    stale.reviewSignals = ["Implementation appears aligned, but current targeted tests are not green due to a timeout"];
    stale.reviewSignalsTask = staleTask;
    stale.reviewControl = {
      status: "needed",
      pending: true,
      consumed: false,
      running: false,
      lastDecision: "review",
      lastReason: "tests are still failing",
    };
    stale.router.review = {
      phase: "closeout",
      label: "not_done",
      confidence: 0.93,
      reason: "tests are still failing",
      source: "llm",
      review: "strict",
      escalate: true,
      trajectory: { failed: true },
    };
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: tests are still failing]\n", "utf8");

    await agentEnd![0]({
      messages: [
        { role: "toolResult", content: "Context broker SQLite initialization failed; attempting recovery. Error: file is not a database" },
        { role: "toolResult", content: "Test Files  3 passed (3)\n      Tests  77 passed (77)\nEXIT:0" },
        { role: "toolResult", content: "PR #215 state=MERGED mergedAt=2026-06-25T19:33:41Z mergeCommit=5fd00aea" },
        { role: "assistant", content: "Merged PR #215. Advisor still reports stale failing-test guidance, but latest structured validation is green." },
      ],
    }, ctx);

    const resolved = readAdvisorState();
    const current = readFileSync(ADVISOR_CURRENT_PATH, "utf8");
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(resolved.followUp).toBe("");
    expect(resolved.followUpTask).toBeUndefined();
    expect(resolved.reviewSignals).toEqual([]);
    expect(resolved.reviewSignalsTask).toBeUndefined();
    expect(resolved.reviewControl.lastDecision).toBe("continue");
    expect(resolved.reviewControl.lastReason).toContain("terminal workflow state");
    expect(resolved.workflow?.terminal).toMatchObject({ state: "merged", pr: 215 });
    expect(resolved.evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation", result: "pass", source: "agent_end" }),
      expect.objectContaining({ kind: "merge", result: "merged", pr: 215, source: "agent_end" }),
    ]));
    expect(resolved.reviewControl.status).toBe("consumed");
    expect(current).toContain("advisor:llm: continue");
    expect(current).not.toContain("tests are still failing");
    expect(JSON.stringify(resolved.router.review ?? {})).not.toContain('"failed":true');
  });

  it("keeps terminal workflow state monotonic across later stale review text", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);

    const task = "merge PR #215 after context-broker validation";
    const terminal = readAdvisorState();
    terminal.lastTask = task;
    terminal.reviewControl = {
      status: "consumed",
      pending: false,
      consumed: true,
      running: false,
      lastDecision: "continue",
      lastReason: "terminal clean closeout evidence",
      terminalEvidence: {
        kind: "tests_and_merge",
        task,
        reason: "terminal clean closeout evidence",
        at: "2026-06-25T19:33:41Z",
      },
    };
    terminal.followUp = "targeted context-broker tests are still failing";
    terminal.followUpTask = task;
    terminal.reviewSignals = ["advisor verdict says review because tests are still failing"];
    terminal.reviewSignalsTask = task;
    terminal.router.review = {
      phase: "closeout",
      label: "not_done",
      confidence: 0.88,
      reason: "tests are still failing",
      source: "llm",
      review: "strict",
      escalate: true,
      trajectory: { failed: true },
    };
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(terminal, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: tests are still failing]\n", "utf8");

    await agentEnd![0]({
      messages: [
        { role: "assistant", content: "Advisor verdict: review. Reason: targeted context-broker vitest runs are still failing." },
      ],
    }, ctx);

    const resolved = readAdvisorState();
    const current = readFileSync(ADVISOR_CURRENT_PATH, "utf8");
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(resolved.reviewControl.lastDecision).toBe("continue");
    expect(resolved.reviewControl.lastReason).toBe("terminal workflow state");
    expect(resolved.reviewControl.terminalEvidence).toEqual(expect.objectContaining({ kind: "tests_and_merge", task }));
    expect(resolved.followUp).toBe("");
    expect(resolved.reviewSignals).toEqual([]);
    expect(current).toContain("advisor:llm: continue");
    expect(current).not.toContain("tests are still failing");
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

  it("does not let a green validation hide a separate non-validation tool failure", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [
        {
          toolName: "bash",
          command: "vitest run --reporter=json",
          exitCode: 0,
          stdout: JSON.stringify({ numFailedTests: 0, numFailedTestSuites: 0, success: true }),
        },
        {
          toolName: "bash",
          command: "gh pr merge 215 --merge",
          exitCode: 1,
          stderr: "GraphQL: Pull request is not mergeable",
        },
      ],
      message: { role: "assistant", content: "Tests are green but the merge command still failed." },
    }, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(readAdvisorState().reviewControl.lastDecision).toBe("review");
    expect(readAdvisorState().followUp).toContain("Closeout is incomplete");
  });

  it("records stale failure then green validation then merged PR as terminal evidence", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    expect(preflight?.length).toBe(1);
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await preflight![0]({ systemPrompt: "SYS", prompt: "Finish issue 217 and merge PR 215" }, ctx);

    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "npm test",
        exitCode: 1,
        stderr: "1 failed test",
      }],
      message: { role: "assistant", content: "Vitest failed before the fix." },
    }, ctx);

    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "vitest run --reporter=json",
        exitCode: 0,
        stdout: JSON.stringify({ numFailedTests: 0, numFailedTestSuites: 0, success: true, assertionResults: [{ failureMessages: ["expected word failed in fixture"] }] }),
      }],
      message: { role: "assistant", content: "Vitest JSON is green even though fixture text contains failed." },
    }, ctx);

    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr view 215 --json state,mergeCommit",
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "merged-sha" } }),
      }],
      message: { role: "assistant", content: "Remote PR state is MERGED." },
    }, ctx);

    const resolved = readAdvisorState();
    const evidence = resolved.evidenceLedger ?? [];
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation", sha: "test-sha", command: "npm test", result: "fail", exitCode: 1, source: "turn_end", timestamp: expect.any(String) }),
      expect.objectContaining({ kind: "validation", sha: "test-sha", command: "vitest run --reporter=json", result: "pass", exitCode: 0, source: "turn_end", timestamp: expect.any(String) }),
      expect.objectContaining({ kind: "merge", sha: "test-sha", command: "gh pr view 215 --json state,mergeCommit", result: "merged", source: "turn_end", timestamp: expect.any(String), pr: 215 }),
    ]));
    expect(resolved.workflow?.terminal).toMatchObject({ state: "merged", sha: "test-sha", source: "turn_end" });
    expect(resolved.followUp).toBe("");
    expect(resolved.reviewSignals).toEqual([]);

    const status = await preflight![0]({ systemPrompt: "SYS", prompt: "Continue issue 217" }, ctx);
    expect(String(status?.systemPrompt)).not.toContain("Advisor follow-up");
    expect(String(status?.systemPrompt)).not.toContain("failed before the fix");
  });

  it("makes a newer green validation authoritative before any merge evidence", async () => {
    const preflight = handlers.before_agent_start;
    const turnEnd = handlers.turn_end;
    expect(preflight?.length).toBe(1);
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await preflight![0]({ systemPrompt: "SYS", prompt: "Fix issue 217" }, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "npm test",
        exitCode: 1,
        stderr: "1 failed test",
      }],
      message: { role: "assistant", content: "Validation failed before the final fix." },
    }, ctx);
    expect(readAdvisorState().followUp).toContain("Closeout is incomplete");
    // Isolate evidence convergence from the independently tested binary review gate.
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }), "utf8");

    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "npm test",
        exitCode: 0,
        stdout: "all tests passed",
      }],
      message: { role: "assistant", content: "Validation is now green." },
    }, ctx);

    const status = await preflight![0]({ systemPrompt: "SYS", prompt: "Continue issue 217" }, ctx);
    expect(String(status?.systemPrompt)).not.toContain("Advisor follow-up");
    expect(String(status?.systemPrompt)).not.toContain("failed before");
    expect(String(status?.systemPrompt)).toContain("Latest validation: pass");
    expect(readAdvisorState().workflow?.terminal).toBeUndefined();
  });

  it("treats Vitest JSON with zero failed tests as green despite failed words", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    // This test covers structured validation parsing, not gate-driven review calls.
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }), "utf8");
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "vitest run --reporter=json",
        status: "error",
        exitCode: 0,
        stdout: JSON.stringify({
          numFailedTests: 0,
          numFailedTestSuites: 0,
          success: true,
          testResults: [{ assertionResults: [{ failureMessages: ["expected output includes the word failed"] }] }],
        }),
      }],
      message: { role: "assistant", content: "Structured Vitest result is green." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(resolved.evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation", command: "vitest run --reporter=json", result: "pass", exitCode: 0 }),
    ]));
    expect(resolved.workflow?.terminal).toBeUndefined();
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it("does not treat generic success JSON as validation evidence", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh api repos/fiale-plus/pi-rogue/actions/runs/123",
        exitCode: 0,
        stdout: JSON.stringify({ success: true }),
      }],
      message: { role: "assistant", content: "GitHub API call succeeded." },
    }, ctx);

    expect(readAdvisorState().evidenceLedger).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation" }),
    ]));
  });

  it("does not treat non-validation output mentioning lint as validation evidence", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh api repos/fiale-plus/pi-rogue/actions/runs/123",
        exitCode: 0,
        stdout: JSON.stringify({ workflowName: "lint", status: "queued" }),
      }],
      message: { role: "assistant", content: "GitHub API call returned lint workflow metadata." },
    }, ctx);

    expect(readAdvisorState().evidenceLedger).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation" }),
    ]));
  });

  it("does not treat generic zero-failure JSON as validation evidence", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh api repos/fiale-plus/pi-rogue/actions/runs/123",
        exitCode: 0,
        stdout: JSON.stringify({ failures: 0 }),
      }],
      message: { role: "assistant", content: "GitHub API call returned a zero-failure field." },
    }, ctx);

    expect(readAdvisorState().evidenceLedger).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation" }),
    ]));
  });


  it("does not let generic success JSON hide a failed non-validation tool", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh api repos/fiale-plus/pi-rogue/actions/runs/123",
        exitCode: 1,
        stdout: JSON.stringify({ success: true }),
      }],
      message: { role: "assistant", content: "GitHub API call failed despite a generic success field in the payload." },
    }, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(readAdvisorState().reviewControl.lastDecision).toBe("review");
  });

  it("rechecks remote PR state after local gh merge worktree errors", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr merge 215 --merge",
        exitCode: 128,
        stderr: "fatal: 'main' is already used by worktree at '/tmp/other'",
      }],
      message: { role: "assistant", content: "Local merge command failed because main is checked out elsewhere." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(execFileSyncMock).toHaveBeenCalledWith("gh", ["pr", "view", "215", "--json", "state,mergeCommit"], expect.any(Object));
    expect(resolved.evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merge", command: "gh pr merge 215 --merge", result: "error", pr: 215 }),
      expect.objectContaining({ kind: "merge", command: "gh pr view 215 --json state,mergeCommit", result: "merged", pr: 215 }),
    ]));
    expect(resolved.workflow?.terminal).toMatchObject({ state: "merged", source: "remote_pr_recheck" });
    expect(resolved.followUp).toBe("");
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it("rechecks current PR when local gh merge worktree error omits PR number", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return "test-sha\n";
      if (command === "gh" && args.join(" ") === "pr view --json state,mergeCommit") {
        return JSON.stringify({ state: "MERGED", mergeCommit: { oid: "merged-sha" } });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr merge --merge",
        exitCode: 128,
        stderr: "fatal: 'main' is already used by worktree at '/tmp/other'",
      }],
      message: { role: "assistant", content: "Local merge command failed because main is checked out elsewhere." },
    }, ctx);

    expect(execFileSyncMock).toHaveBeenCalledWith("gh", ["pr", "view", "--json", "state,mergeCommit"], expect.any(Object));
    expect(readAdvisorState().workflow?.terminal).toMatchObject({ state: "merged", source: "remote_pr_recheck" });
  });

  it("does not mark gh merge exit zero terminal without confirmed merged state", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return "test-sha\n";
      if (command === "gh" && args.join(" ") === "pr view 215 --json state,mergeCommit") {
        return JSON.stringify({ state: "OPEN" });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr merge 215 --merge",
        exitCode: 0,
        stdout: "Auto-merge enabled for pull request #215",
      }],
      message: { role: "assistant", content: "Local merge command succeeded but remote PR remains open." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(execFileSyncMock).toHaveBeenCalledWith("gh", ["pr", "view", "215", "--json", "state,mergeCommit"], expect.any(Object));
    expect(resolved.workflow?.terminal).toBeUndefined();
    expect(resolved.evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merge", command: "gh pr view 215 --json state,mergeCommit", result: "not_merged", pr: 215 }),
    ]));
  });

  it("rechecks gh merge success text before terminal merge", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return "test-sha\n";
      if (command === "gh" && args.join(" ") === "pr view 215 --json state,mergeCommit") {
        return JSON.stringify({ state: "OPEN" });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr merge 215 --merge",
        exitCode: 0,
        stdout: "✓ Pull Request successfully merged",
      }],
      message: { role: "assistant", content: "Local merge command printed success text but remote PR remains open." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(execFileSyncMock).toHaveBeenCalledWith("gh", ["pr", "view", "215", "--json", "state,mergeCommit"], expect.any(Object));
    expect(resolved.workflow?.terminal).toBeUndefined();
    expect(resolved.evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merge", command: "gh pr view 215 --json state,mergeCommit", result: "not_merged", pr: 215 }),
    ]));
  });

  it("keeps merge warning when validation pass and gh merge exit zero leave PR open in one review-off batch", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return "test-sha\n";
      if (command === "gh" && args.join(" ") === "pr view 215 --json state,mergeCommit") {
        return JSON.stringify({ state: "OPEN" });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    await handlers.session_start?.[0]?.({}, ctx);
    const stale = readAdvisorState();
    stale.lastTask = "finish issue 217";
    stale.followUp = "Old verdict: merge is incomplete.";
    stale.followUpTask = stale.lastTask;
    stale.reviewSignals = ["Old merge warning"];
    stale.reviewSignalsTask = stale.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: Old verdict: merge is incomplete]\n", "utf8");

    await turnEnd![0]({
      toolResults: [
        {
          toolName: "bash",
          command: "npm test",
          exitCode: 0,
          stdout: "Test Files 10 passed (10)\nTests 100 passed (100)",
        },
        {
          toolName: "bash",
          command: "gh pr merge 215 --merge",
          exitCode: 0,
          stdout: "Auto-merge enabled for pull request #215",
        },
      ],
      message: { role: "assistant", content: "Validation passed, then merge command left the PR open." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(resolved.workflow?.terminal).toBeUndefined();
    expect(resolved.followUp).toBe("Old verdict: merge is incomplete.");
    expect(resolved.reviewSignals).toEqual(["Old merge warning"]);
    expect(readFileSync(ADVISOR_CURRENT_PATH, "utf8")).toContain("Old verdict");
  });


  it("opens a rate-limit circuit breaker instead of replaying stale review verdicts", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const stale = readAdvisorState();
    stale.lastTask = "finish issue 217";
    stale.followUp = "Old verdict: merge is incomplete.";
    stale.followUpTask = stale.lastTask;
    stale.reviewSignals = ["Old failed-test warning"];
    stale.reviewSignalsTask = stale.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");

    completeSimpleMock.mockRejectedValue(new Error(JSON.stringify({
      type: "error",
      code: "rate_limit_exceeded",
      status_code: 429,
      message: "weekly limit reached",
      headers: { "Retry-After": "120" },
    })));

    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: "Changed advisor rate-limit handling." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(resolved.rateLimit).toMatchObject({ active: true, reason: expect.stringContaining("429") });
    expect(resolved.followUp).toBe("");
    expect(resolved.reviewSignals).toEqual([]);
    expect(resolved.reviewControl.lastReason).toContain("rate limit");
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Old verdict") }),
      expect.anything(),
    );
  });


  it("reopens review when a real failure follows green closeout before merge", async () => {
    const agentEnd = handlers.agent_end;
    const turnEnd = handlers.turn_end;
    expect(agentEnd?.length).toBe(1);
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await agentEnd![0]({
      messages: [
        { role: "assistant", content: "Revalidated clean: tests passed, typecheck passed, and final Codex review had no findings." },
      ],
    }, ctx);
    expect(readAdvisorState().workflow?.terminal).toMatchObject({ state: "green" });

    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr merge 215 --merge",
        exitCode: 1,
        stderr: "GraphQL: Pull request is not mergeable",
      }],
      message: { role: "assistant", content: "Merge still failed after green closeout." },
    }, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(readAdvisorState().reviewControl.lastDecision).toBe("review");
    expect(readAdvisorState().reviewControl.terminalEvidence).toBeUndefined();
  });

  it("clears stale follow-up immediately when merged evidence is observed with review off", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const stale = readAdvisorState();
    stale.lastTask = "finish issue 217";
    stale.followUp = "Old verdict: merge is incomplete.";
    stale.followUpTask = stale.lastTask;
    stale.reviewSignals = ["Old failed-test warning"];
    stale.reviewSignalsTask = stale.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: Old verdict: merge is incomplete]\n", "utf8");

    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "gh pr view 215 --json state,mergeCommit",
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "merged-sha" } }),
      }],
      message: { role: "assistant", content: "Remote PR state is MERGED." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(resolved.workflow?.terminal).toMatchObject({ state: "merged" });
    expect(resolved.followUp).toBe("");
    expect(resolved.reviewSignals).toEqual([]);
    const current = readFileSync(ADVISOR_CURRENT_PATH, "utf8");
    expect(current).toContain("advisor:llm: continue");
    expect(current).not.toContain("Old verdict");
  });

  it("keeps stale warning visible when review-off batch has validation pass plus merge failure", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const stale = readAdvisorState();
    stale.lastTask = "finish issue 217";
    stale.followUp = "Old verdict: merge is incomplete.";
    stale.followUpTask = stale.lastTask;
    stale.reviewSignals = ["Old failed-test warning"];
    stale.reviewSignalsTask = stale.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: Old verdict: merge is incomplete]\n", "utf8");

    await turnEnd![0]({
      toolResults: [
        {
          toolName: "bash",
          command: "vitest run --reporter=json",
          exitCode: 0,
          stdout: JSON.stringify({ numFailedTests: 0, numFailedTestSuites: 0, success: true }),
        },
        {
          toolName: "bash",
          command: "gh pr merge 215 --merge",
          exitCode: 1,
          stderr: "GraphQL: Pull request is not mergeable",
        },
      ],
      message: { role: "assistant", content: "Validation passed, but merge failed." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(resolved.followUp).toBe("Old verdict: merge is incomplete.");
    expect(resolved.reviewSignals).toEqual(["Old failed-test warning"]);
    expect(readFileSync(ADVISOR_CURRENT_PATH, "utf8")).toContain("Old verdict");
  });

  it("lets a later validation pass in the same review-off batch clear an earlier validation failure", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const stale = readAdvisorState();
    stale.lastTask = "finish issue 217";
    stale.followUp = "Old verdict: tests are still failing.";
    stale.followUpTask = stale.lastTask;
    stale.reviewSignals = ["Old failed-test warning"];
    stale.reviewSignalsTask = stale.lastTask;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }, null, 2), "utf8");
    writeFileSync(ADVISOR_CURRENT_PATH, "[advisor:llm: review, reason: Old verdict: tests are still failing]\n", "utf8");

    await turnEnd![0]({
      toolResults: [
        {
          toolName: "bash",
          command: "vitest run packages/advisor/src/loop-convergence.test.ts",
          exitCode: 1,
          stderr: "Test Files 1 failed (1)",
        },
        {
          toolName: "bash",
          command: "vitest run packages/advisor/src/loop-convergence.test.ts --reporter=json",
          exitCode: 0,
          stdout: JSON.stringify({ numFailedTests: 0, numFailedTestSuites: 0, success: true }),
        },
      ],
      message: { role: "assistant", content: "Failed first, then reran green." },
    }, ctx);

    const resolved = readAdvisorState();
    expect(resolved.followUp).toBe("");
    expect(resolved.reviewSignals).toEqual([]);
    expect(readFileSync(ADVISOR_CURRENT_PATH, "utf8")).toContain("advisor:llm: continue");
  });

  it("records agent-end merge evidence even while advisor review is paused", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const paused = readAdvisorState();
    paused.advisorPauseUntilTurn = 10;
    writeFileSync(ADVISOR_STATE_PATH, JSON.stringify(paused, null, 2), "utf8");

    await agentEnd![0]({
      messages: [
        { role: "assistant", content: `gh pr view 215 --json state,mergeCommit\n${JSON.stringify({ state: "MERGED", mergeCommit: { oid: "merged-sha" } })}` },
      ],
    }, ctx);

    expect(readAdvisorState().evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merge", result: "merged", pr: 215, source: "agent_end" }),
    ]));
  });

  it("persists agent-end merge evidence before normal review reloads state", async () => {
    const agentEnd = handlers.agent_end;
    expect(agentEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await agentEnd![0]({
      messages: [
        { role: "assistant", content: `gh pr view 215 --json state,mergeCommit\n${JSON.stringify({ state: "MERGED", mergeCommit: { oid: "merged-sha" } })}` },
      ],
    }, ctx);

    const resolved = readAdvisorState();
    expect(resolved.evidenceLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merge", result: "merged", pr: 215, source: "agent_end" }),
    ]));
    expect(resolved.workflow?.terminal).toMatchObject({ state: "merged" });
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it("opens rate-limit circuit breaker from structured error properties", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    const error = Object.assign(new Error("provider rejected"), {
      status: 429,
      headers: { "Retry-After": "60" },
    });
    completeSimpleMock.mockRejectedValue(error);

    await turnEnd![0]({
      toolResults: [{ toolName: "edit" }],
      message: { role: "assistant", content: "Changed advisor rate-limit handling." },
    }, ctx);

    expect(readAdvisorState().rateLimit).toMatchObject({ active: true, retryAfterSeconds: 60 });
  });

  it("does not hide a mixed-command failure behind green Vitest JSON", async () => {
    const turnEnd = handlers.turn_end;
    expect(turnEnd?.length).toBe(1);

    await handlers.session_start?.[0]?.({}, ctx);
    await turnEnd![0]({
      toolResults: [{
        toolName: "bash",
        command: "vitest run --reporter=json && gh pr merge 215 --merge",
        exitCode: 1,
        stdout: JSON.stringify({ numFailedTests: 0, numFailedTestSuites: 0, success: true }),
        stderr: "GraphQL: Pull request is not mergeable",
      }],
      message: { role: "assistant", content: "Vitest passed, but merge failed in the same shell command." },
    }, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(readAdvisorState().reviewControl.lastDecision).toBe("review");
  });

  it("invokes review for a trusted gate escalation without material signals, unless review is off", async () => {
    const turnEnd = handlers.turn_end;
    const gate = vi.spyOn(advisorRouter, "binaryGatePredict").mockReturnValue({
      decision: "escalate",
      confidence: 0.91,
      probability: 0.91,
      threshold: 0.5,
      source: "model-v2",
      trusted: true,
    });
    try {
      await handlers.session_start?.[0]?.({}, ctx);
      await turnEnd![0]({ toolResults: [], message: { role: "assistant", content: "Looks okay." } }, ctx);
      expect(completeSimpleMock).toHaveBeenCalledTimes(1);
      expect(readAdvisorState().router.review).toMatchObject({ label: "course_correct", review: "strict", escalate: true });

      completeSimpleMock.mockClear();
      writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "auto", review: "off", checkins: "off", checkinIntervalMinutes: 30 }), "utf8");
      await turnEnd![0]({ toolResults: [], message: { role: "assistant", content: "Still okay." } }, ctx);
      expect(completeSimpleMock).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
    }
  });

  it("keeps manual mode free of automatic post-turn and agent-end model calls", async () => {
    const turnEnd = handlers.turn_end;
    const agentEnd = handlers.agent_end;
    writeFileSync(ADVISOR_CONFIG_PATH, JSON.stringify({ mode: "manual", review: "strict", checkins: "off", checkinIntervalMinutes: 30 }), "utf8");
    await handlers.session_start?.[0]?.({}, ctx);

    await turnEnd![0]({ toolResults: [{ toolName: "edit" }], message: { role: "assistant", content: "Edited a file." } }, ctx);
    await agentEnd![0]({ messages: [{ role: "toolResult", content: "edit tool changed file" }, { role: "assistant", content: "Done." }] }, ctx);

    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(readAdvisorState().notes).toContain("Edited a file.");

    await commands["pi-rogue-advisor"].handler("manual question still works", ctx);
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
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
