import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerContextBrokerBeta, shouldEnableContextBrokerBeta } from "./extension.js";

function createPiMock() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi: any = {
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  };
  return { pi, handlers, commands, tools };
}

function createCtx(entries: any[] = []) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    ctx: {
      cwd: "/repo",
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
        setStatus() {},
      },
      sessionManager: {
        getSessionFile() {
          return "/sessions/current.jsonl";
        },
        getBranch() {
          return entries;
        },
      },
    } as any,
    notifications,
  };
}

async function runHandlers(handlers: Map<string, any[]>, name: string, event: any, ctx: any) {
  for (const handler of handlers.get(name) ?? []) {
    await handler(event, ctx);
  }
}

describe("context broker beta enablement", () => {
  const oldEnv = process.env.PI_CONTEXT_BROKER_ENABLED;

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.PI_CONTEXT_BROKER_ENABLED;
    else process.env.PI_CONTEXT_BROKER_ENABLED = oldEnv;
  });

  it("is disabled by default unless explicitly opted in", () => {
    delete process.env.PI_CONTEXT_BROKER_ENABLED;
    expect(shouldEnableContextBrokerBeta()).toBe(false);

    process.env.PI_CONTEXT_BROKER_ENABLED = "true";
    expect(shouldEnableContextBrokerBeta()).toBe(true);
  });

  it("registers /context with command completions and the context_lookup tool", () => {
    const { pi, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi);

    const command = commands.get("context");
    expect(command).toBeTruthy();
    expect(tools.has("context_lookup")).toBe(true);
    expect(command.getArgumentCompletions("")?.map((item: any) => item.value.trim())).toEqual([
      "status",
      "brief",
      "lookup",
      "pin",
      "prune",
    ]);
  });

  it("backfills current branch toolResult and bashExecution entries idempotently", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi);
    const entries = [
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-06-05T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "README.md" } }] },
      },
      {
        type: "message",
        id: "tool-1",
        timestamp: "2026-06-05T00:00:00.000Z",
        message: { role: "toolResult", toolCallId: "tc-read", toolName: "read", content: [{ type: "text", text: "readme" }], isError: false },
      },
      {
        type: "message",
        id: "bash-1",
        timestamp: "2026-06-05T00:00:01.000Z",
        message: { role: "bashExecution", command: "npm test", output: "passed", exitCode: 0, cancelled: false, truncated: false },
      },
    ];
    const { ctx, notifications } = createCtx(entries);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await commands.get("context").handler("status", ctx);
    await commands.get("context").handler("lookup README.md", ctx);

    expect(notifications[0].message).toContain("Backfilled 2/2");
    expect(notifications[1].message).toContain("Backfilled 0/2");
    expect(notifications.at(-2)?.message).toContain("records=2");
    expect(notifications.at(-1)?.message).toContain("README.md");
  });

  it("purges unpinned broker artifacts after session compaction", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { briefBytes: 1200 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "scratch-call",
      toolName: "bash",
      input: { command: "echo scratch" },
      content: [{ type: "text", text: "scratch payload" }],
      isError: false,
    }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "keep-call",
      toolName: "bash",
      input: { command: "echo keep" },
      content: [{ type: "text", text: "keep payload" }],
      isError: false,
    }, ctx);
    const keepCompletion = commands.get("context").getArgumentCompletions("pin ")?.find((item: any) => String(item.description).includes("echo keep"));
    const keepHandle = keepCompletion?.value.replace(/^pin /, "");
    expect(keepHandle).toBeTruthy();
    await commands.get("context").handler(`pin ${keepHandle}`, ctx);

    await runHandlers(handlers, "session_compact", { type: "session_compact", compactionEntry: { summary: "compact" }, fromExtension: false }, ctx);
    await commands.get("context").handler("brief", ctx);

    const brief = notifications.at(-1)?.message ?? "";
    expect(brief).toContain("echo keep");
    expect(brief).not.toContain("echo scratch");
    expect(notifications.some((item) => item.message.includes("compact cleanup purged 1 unpinned artifact"))).toBe(true);
  });

  it("is safe on malformed session branches", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi);
    const { ctx, notifications } = createCtx([null, { type: "message", id: "broken", message: null }]);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

    expect(notifications[0].message).toContain("Backfilled 0/0");
  });

  it("does not backfill bash entries explicitly excluded from context", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi);
    const { ctx, notifications } = createCtx([
      {
        type: "message",
        id: "secret-bash",
        timestamp: "2026-06-05T00:00:00.000Z",
        message: {
          role: "bashExecution",
          command: "echo SECRET_TOKEN=abc123",
          output: "SECRET_TOKEN=abc123",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext: true,
        },
      },
    ]);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await commands.get("context").handler("brief", ctx);

    expect(notifications[0].message).toContain("Backfilled 0/0");
    expect(notifications.at(-1)?.message).not.toContain("SECRET_TOKEN");
  });

  it("exact lookup returns byte-clipped payloads and marks truncation explicitly", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 80, searchBytes: 50 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "printf long" },
      content: [{ type: "text", text: "測試".repeat(100) }],
      isError: false,
    }, ctx);

    const lookupCompletion = commands.get("context").getArgumentCompletions("lookup ")?.[0];
    expect(lookupCompletion.value).toMatch(/^lookup ctx:\/\//);

    await commands.get("context").handler(lookupCompletion.value, ctx);
    const payload = notifications.at(-1)?.message.split("payload:\n").at(-1) ?? "";
    expect(notifications.at(-1)?.message).toContain("payload:");
    expect(payload).toContain("[truncated: omitted");
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(80);
  });

  it("text search lookup returns a smaller byte-clipped excerpt", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 80, searchBytes: 50 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-2",
      toolName: "bash",
      input: { command: "echo needle" },
      content: [{ type: "text", text: "needle " + "✅".repeat(100) }],
      isError: false,
    }, ctx);

    await commands.get("context").handler("lookup needle", ctx);
    const payload = notifications.at(-1)?.message.split("payload:\n").at(-1) ?? "";
    expect(notifications.at(-1)?.message).toContain("payload:");
    expect(payload).toContain("[truncated: omitted");
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(50);
  });

  it("context_lookup tool dereferences handles for exact evidence", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 500 });
    const { ctx } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-tool-lookup",
      toolName: "bash",
      input: { command: "echo evidence" },
      content: [{ type: "text", text: "exact evidence payload" }],
      isError: false,
    }, ctx);
    const handle = commands.get("context").getArgumentCompletions("lookup ")?.[0].value.replace(/^lookup /, "");
    const result = await tools.get("context_lookup").execute("lookup-call", { handle }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain(handle);
    expect(result.content[0].text).toContain("exact evidence payload");
  });

  it("does not broker context_lookup results recursively", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 500, rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-source",
      toolName: "bash",
      input: { command: "echo source" },
      content: [{ type: "text", text: "source evidence payload" }],
      isError: false,
    }, ctx);
    const handle = commands.get("context").getArgumentCompletions("lookup ")?.[0].value.replace(/^lookup /, "");
    const lookupResult = await tools.get("context_lookup").execute("lookup-call", { handle }, undefined, undefined, ctx);

    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "lookup-call",
      toolName: "context_lookup",
      input: { handle },
      content: lookupResult.content,
      isError: false,
    }, ctx);
    const contextResult = await handlers.get("context")?.[0]({
      type: "context",
      messages: [{ role: "toolResult", toolCallId: "lookup-call", toolName: "context_lookup", content: lookupResult.content, isError: false }],
    }, ctx);
    await commands.get("context").handler("brief", ctx);

    const rewrittenLookup = contextResult.messages[0].content[0].text;
    const brief = notifications.at(-1)?.message ?? "";
    expect(rewrittenLookup).toContain("Context lookup result omitted from prompt");
    expect(rewrittenLookup).not.toContain("source evidence payload");
    expect(rewrittenLookup).not.toContain("Context broker artifact: ctx://");
    expect(brief).toContain("echo source");
    expect(brief).not.toContain("completed context_lookup");
  });

  it("still brokers normal tool output that exactly matches broker marker text", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi);
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "grep-call",
      toolName: "bash",
      input: { command: "grep ctx session.log" },
      content: [{ type: "text", text: [
        "Context broker artifact: ctx://session/example",
        "Summary: copied placeholder",
        "Payload bytes: 10",
        "Raw payload omitted from prompt. Use /context lookup <handle> if exact evidence is needed.",
      ].join("\n") }],
      isError: false,
    }, ctx);
    await commands.get("context").handler("brief", ctx);

    expect(notifications.at(-1)?.message).toContain("grep ctx session.log");
  });

  it("context_lookup refuses empty unfocused payload-dumping calls", async () => {
    const { pi, handlers, tools } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 500 });
    const { ctx } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-empty-lookup",
      toolName: "bash",
      input: { command: "echo hidden" },
      content: [{ type: "text", text: "payload must not dump" }],
      isError: false,
    }, ctx);

    const result = await tools.get("context_lookup").execute("lookup-call", {}, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("requires a focused filter");
    expect(result.content[0].text).not.toContain("payload must not dump");
  });

  it("rewrites large historical tool results in context to live broker handles", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, lookupBytes: 500 });
    const { ctx, notifications } = createCtx();
    const raw = "RAW_TOOL_OUTPUT_" + "x".repeat(100);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "call-large", name: "bash", arguments: { command: "printf raw" } }] },
        { role: "toolResult", toolCallId: "call-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: false, timestamp: 1 },
      ],
    }, ctx);

    const text = result.messages[1].content[0].text;
    const handle = text.match(/ctx:\/\/\S+/)?.[0];
    expect(text).toContain("Context broker artifact: ctx://");
    expect(text).toContain("Raw payload omitted from prompt");
    expect(text).not.toContain(raw);

    await commands.get("context").handler(`lookup ${handle}`, ctx);
    expect(notifications.at(-1)?.message).toContain("RAW_TOOL_OUTPUT_");
  });

  it("leaves small tool results and excluded bash outputs unchanged in context", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40 });
    const { ctx } = createCtx();
    const secret = "SECRET_TOKEN=" + "z".repeat(80);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "toolResult", toolCallId: "small", toolName: "read", content: [{ type: "text", text: "small" }], isError: false, timestamp: 1 },
        { role: "bashExecution", command: "echo secret", output: secret, exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 2 },
      ],
    }, ctx);

    expect(result).toBeUndefined();
  });

  it("does not collapse repeated bash rewrites for the same command and timestamp", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 20 });
    const { ctx, notifications } = createCtx();
    const firstRaw = "FIRST_RAW_" + "x".repeat(80);
    const secondRaw = "SECOND_RAW_" + "y".repeat(80);
    const sameTimestamp = Date.now();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "bashExecution", command: "npm test", output: firstRaw, exitCode: 0, cancelled: false, truncated: false, timestamp: sameTimestamp },
        { role: "bashExecution", command: "npm test", output: secondRaw, exitCode: 0, cancelled: false, truncated: false, timestamp: sameTimestamp },
      ],
    }, ctx);

    const firstHandle = result.messages[0].output.match(/ctx:\/\/\S+/)?.[0];
    const secondHandle = result.messages[1].output.match(/ctx:\/\/\S+/)?.[0];
    expect(firstHandle).toBeTruthy();
    expect(secondHandle).toBeTruthy();
    expect(firstHandle).not.toBe(secondHandle);

    await commands.get("context").handler(`lookup ${secondHandle}`, ctx);
    expect(notifications.at(-1)?.message).toContain("SECOND_RAW_");
    expect(notifications.at(-1)?.message).not.toContain("FIRST_RAW_");
  });

  it("does not emit dead handles when one context pass exceeds retention caps", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1, maxRecords: 2, lookupBytes: 500 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [0, 1, 2].map((index) => ({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "bash",
        content: [{ type: "text", text: `RAW_${index}_` + "x".repeat(20) }],
        isError: false,
        timestamp: Date.now() + index,
      })),
    }, ctx);

    const handles = result.messages
      .map((message: any) => String(message.content?.[0]?.text ?? "").match(/ctx:\/\/\S+/)?.[0])
      .filter(Boolean);
    expect(handles.length).toBeLessThanOrEqual(2);
    expect(result.messages.some((message: any) => String(message.content?.[0]?.text ?? "").includes("RAW_0_"))).toBe(true);

    for (const handle of handles) {
      await commands.get("context").handler(`lookup ${handle}`, ctx);
      expect(notifications.at(-1)?.message).not.toContain("No context artifacts matched");
      expect(notifications.at(-1)?.message).toContain("RAW_");
    }
  });

  it("redacts secrets before storing and displaying payloads", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi);
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "secret-call",
      toolName: "bash",
      input: { command: "echo token=abc123456789", password: "hunter2" },
      content: [{ type: "text", text: "OPENAI_API_KEY=sk-abcdefghijklmnop" }],
      details: { nested: { apiKey: "object-secret-value" } },
      isError: false,
    }, ctx);

    const lookupCompletion = commands.get("context").getArgumentCompletions("lookup ")?.[0];
    await commands.get("context").handler(lookupCompletion.value, ctx);

    expect(notifications.at(-1)?.message).not.toContain("abc123456789");
    expect(notifications.at(-1)?.message).not.toContain("hunter2");
    expect(notifications.at(-1)?.message).not.toContain("object-secret-value");
    expect(notifications.at(-1)?.message).not.toContain("sk-abcdefghijklmnop");
    expect(notifications.at(-1)?.message).toContain("[REDACTED");
  });

  it("re-publishes stale source handles instead of restoring raw prompt payloads", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { maxRecords: 1, rewriteThresholdBytes: 20 });
    const { ctx } = createCtx();
    const raw = "STALE_RAW_PAYLOAD_" + "x".repeat(100);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "stale-call",
      toolName: "bash",
      input: { command: "echo stale" },
      content: [{ type: "text", text: raw }],
      isError: false,
      timestamp: 1,
    }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "newer-call",
      toolName: "bash",
      input: { command: "echo newer" },
      content: [{ type: "text", text: "newer" }],
      isError: false,
      timestamp: 2,
    }, ctx);
    await commands.get("context").handler("prune", ctx);

    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [{ role: "toolResult", toolCallId: "stale-call", toolName: "bash", content: [{ type: "text", text: raw }], isError: false, timestamp: 1 }],
    }, ctx);

    expect(result.messages[0].content[0].text).toContain("Context broker artifact: ctx://");
    expect(result.messages[0].content[0].text).not.toContain(raw);
  });

  it("can reload artifacts and pin state from durable blob storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-test-"));
    try {
      const first = createPiMock();
      registerContextBrokerBeta(first.pi, { durable: true, storeDir: dir });
      const { ctx } = createCtx();
      await runHandlers(first.handlers, "session_start", { type: "session_start" }, ctx);
      await runHandlers(first.handlers, "tool_result", {
        type: "tool_result",
        toolCallId: "durable-call",
        toolName: "bash",
        input: { command: "echo durable" },
        content: [{ type: "text", text: "durable payload" }],
        isError: false,
        timestamp: 100,
      }, ctx);
      const handle = first.commands.get("context").getArgumentCompletions("lookup ")?.[0].value.replace(/^lookup /, "");
      await first.commands.get("context").handler(`pin ${handle}`, ctx);

      const second = createPiMock();
      const secondRun = createCtx();
      registerContextBrokerBeta(second.pi, { durable: true, storeDir: dir });
      await runHandlers(second.handlers, "session_start", { type: "session_start" }, secondRun.ctx);
      const secondHandle = second.commands.get("context").getArgumentCompletions("lookup ")?.[0].value.replace(/^lookup /, "");
      await second.commands.get("context").handler(`lookup ${handle}`, secondRun.ctx);
      await second.commands.get("context").handler("brief", secondRun.ctx);

      const third = createPiMock();
      const thirdRun = createCtx();
      registerContextBrokerBeta(third.pi, { durable: true, storeDir: dir });
      await runHandlers(third.handlers, "session_start", { type: "session_start" }, thirdRun.ctx);
      await third.commands.get("context").handler(`lookup ${secondHandle}`, thirdRun.ctx);
      await third.commands.get("context").handler("brief", thirdRun.ctx);

      expect(secondRun.notifications.at(-2)?.message).toContain("durable payload");
      expect(secondRun.notifications.at(-1)?.message).toContain("tier=hot");
      expect(secondRun.notifications.at(-1)?.message).toContain("pinned");
      expect(thirdRun.notifications.at(-2)?.message).toContain("durable payload");
      expect(thirdRun.notifications.at(-1)?.message).toContain("tier=hot");
      expect(thirdRun.notifications.at(-1)?.message).toContain("pinned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects a bounded broker brief without raw payload text", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { briefBytes: 220 });
    const { ctx } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-3",
      toolName: "bash",
      input: { command: "echo secret" },
      content: [{ type: "text", text: "SECRET_TOKEN=" + "z".repeat(200) }],
      isError: false,
    }, ctx);

    const result = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);

    expect(Buffer.byteLength(result.systemPrompt, "utf8")).toBeLessThanOrEqual(Buffer.byteLength("base\n\n", "utf8") + 220 + 180);
    expect(result.systemPrompt).toContain("Context Broker");
    expect(result.systemPrompt).toContain("ctx://");
    expect(result.systemPrompt).not.toContain("SECRET_TOKEN");
  });
});
