import { afterEach, describe, expect, it } from "vitest";
import { registerContextBrokerBeta, shouldEnableContextBrokerBeta } from "./extension.js";

function createPiMock() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const pi: any = {
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  };
  return { pi, handlers, commands };
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

  it("registers /context with command completions", () => {
    const { pi, commands } = createPiMock();
    registerContextBrokerBeta(pi);

    const command = commands.get("context");
    expect(command).toBeTruthy();
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
