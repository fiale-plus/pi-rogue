import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("./sqlite.js", async () => {
  const actual = await vi.importActual<typeof import("./sqlite.js")>("./sqlite.js");
  return {
    ...actual,
    createSqliteContextBroker: vi.fn((options: Parameters<typeof actual.createSqliteContextBroker>[0]) => actual.createSqliteContextBroker(options)),
  };
});

import { registerContextBrokerBeta, rememberNewestSource, shouldEnableContextBrokerBeta } from "./extension.js";
import { createSqliteContextBroker } from "./sqlite.js";

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

describe("context broker extension enablement", () => {
  it("retains the newest 64 source cache entries per session", () => {
    const seen = new Set<string>();
    const handles = new Map<string, string>();
    for (let index = 0; index < 65; index += 1) {
      const key = `session\u0000source-${index}`;
      handles.set(key, `ctx://${index}`);
      rememberNewestSource(seen, handles, key);
    }

    expect(seen).toHaveLength(64);
    expect(seen.has("session\u0000source-0")).toBe(false);
    expect(handles.has("session\u0000source-0")).toBe(false);
    expect(seen.has("session\u0000source-64")).toBe(true);
    expect(handles.get("session\u0000source-64")).toBe("ctx://64");
  });

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

  it("registers /pi-rogue-context with command completions and the context_lookup tool", () => {
    const { pi, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });

    const command = commands.get("pi-rogue-context");
    expect(command).toBeTruthy();
    expect(tools.has("context_lookup")).toBe(true);
    expect(command.getArgumentCompletions("")?.map((item: any) => item.value.trim())).toEqual([
      "status",
      "brief",
      "lookup",
      "pin",
      "export",
      "config",
      "prune",
    ]);
    expect(command.getArgumentCompletions("config threshold ")?.map((item: any) => item.value)).toContain("config threshold 8192");
    expect(command.getArgumentCompletions("config lenses ")?.map((item: any) => item.value)).toEqual(expect.arrayContaining(["config lenses on", "config lenses off"]));
  });

  it("backfills current branch toolResult and bashExecution entries idempotently", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
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
    await commands.get("pi-rogue-context").handler("status", ctx);
    await commands.get("pi-rogue-context").handler("lookup README.md", ctx);

    expect(notifications[0].message).toContain("Backfilled 2/2");
    expect(notifications[1].message).toContain("Backfilled 0/2");
    expect(notifications.find((entry) => entry.message.includes("Context broker: enabled"))?.message).toContain("records=2");
    expect(notifications.at(-1)?.message).toContain("README.md");
  });

  it("keeps an older live result when its single publish triggers the record cap", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { maxRecords: 1, rewriteThresholdBytes: 1 });
    const { ctx } = createCtx();
    const now = Date.now();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result", toolCallId: "newer", toolName: "bash", content: [{ type: "text", text: "newer live result" }], isError: false, timestamp: now,
    }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result", toolCallId: "older", toolName: "bash", content: [{ type: "text", text: "older live result" }], isError: false, timestamp: now - 1,
    }, ctx);

    const broker = (pi as any).__piRogueContextBroker;
    expect(broker.lookup({ text: "older live result" }, ctx)).toHaveLength(1);
    expect(broker.lookup({ text: "newer live result" }, ctx)).toEqual([]);
  });

  it("skips a malformed persisted source without rejecting valid backfill candidates", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx([
      { type: "message", id: "bad-entry", message: { role: "toolResult", toolCallId: "x".repeat(513), toolName: "bash", content: [{ type: "text", text: "bad" }], isError: false } },
      { type: "message", id: "good-entry", message: { role: "toolResult", toolCallId: "good-source", toolName: "bash", content: [{ type: "text", text: "good" }], isError: false } },
    ]);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

    expect(notifications[0]?.message).toContain("Backfilled 1/2");
    expect(notifications[0]?.message).toContain("1 malformed skipped");
    expect((pi as any).__piRogueContextBroker.status().records).toBe(1);
  });

  it("bounds resume backfill and does not republish a pruned active tail", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { maxRecords: 16, rewriteThresholdBytes: 1 });
    const entries = Array.from({ length: 80 }, (_, index) => ({
      type: "message",
      id: `tool-entry-${index}`,
      message: {
        role: "toolResult",
        toolCallId: `tool-call-${index}`,
        toolName: "bash",
        content: [{ type: "text", text: `bounded payload ${index}` }],
        isError: false,
      },
    }));
    const { ctx, notifications } = createCtx(entries);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    expect(notifications[0]?.message).toContain("Backfilled 64/64");
    expect((pi as any).__piRogueContextBroker.status().records).toBe(16);

    // The unchanged second resume is bounded and performs no new publishes,
    // despite cap pruning having removed 48 of the active-tail artifacts.
    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    expect(notifications[1]?.message).toContain("Backfilled 0/64");
    expect((pi as any).__piRogueContextBroker.status().records).toBe(16);

    // Compaction removes the retained records, but it must not force a full
    // synchronous replay of the unchanged pre-compaction branch on resume.
    await runHandlers(handlers, "session_compact", { type: "session_compact" }, ctx);
    expect((pi as any).__piRogueContextBroker.status().records).toBe(0);
    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    expect(notifications.at(-1)?.message).toContain("Backfilled 0/64");
    expect((pi as any).__piRogueContextBroker.status().records).toBe(0);

    await commands.get("pi-rogue-context").handler("status", ctx);
    const telemetry = notifications.at(-1)?.message ?? "";
    expect(telemetry).toContain("backfill scans=192 limit=64 skippedSeen=0 added=64 errors=0");
    expect(telemetry).toContain("branchEntriesScanned=240");
    expect(telemetry).toContain("candidateSourceIds=192");
    expect(telemetry).toContain("duplicateSources=128");
    expect(telemetry).toContain("actualPublished=64");
    expect(telemetry).toContain("actualPruned=48");
    expect(telemetry).toContain("batchCommits=3");
  });

  it("caps sparse huge-branch startup scans by raw-entry budget", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const entries: any[] = Array.from({ length: 2_000 }, (_, index) => ({
      type: "message",
      id: `noise-${index}`,
      message: { role: "assistant", content: [{ type: "text", text: "unrelated history" }] },
    }));
    // The newest raw-entry window has sparse eligible results. The older half
    // must not be examined merely to collect tool-call input metadata.
    for (let index = 1_488; index < 2_000; index += 8) {
      entries[index] = {
        type: "message",
        id: `sparse-tool-${index}`,
        message: { role: "toolResult", toolCallId: `sparse-call-${index}`, toolName: "bash", content: [{ type: "text", text: `sparse ${index}` }] },
      };
    }
    const { ctx, notifications } = createCtx(entries);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    expect(notifications[0]?.message).toContain("Backfilled 64/64");
    await commands.get("pi-rogue-context").handler("status", ctx);
    expect(notifications.at(-1)?.message).toContain("branchEntriesScanned=512");
    expect(notifications.at(-1)?.message).toContain("backfill scans=64 limit=64");
  });

  it("uses one durable backfill batch and preserves provenance across fresh registration after compaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-extension-durable-tail-"));
    try {
      const entries = Array.from({ length: 80 }, (_, index) => ({
        type: "message",
        id: `entry-${index}`,
        message: { role: "toolResult", toolCallId: `call-${index}`, toolName: "bash", content: [{ type: "text", text: `payload ${index}` }] },
      }));
      const first = createPiMock();
      const firstRun = createCtx(entries);
      await registerContextBrokerBeta(first.pi, { durable: true, storeDir: dir, maxRecords: 16, rewriteThresholdBytes: 1 });
      await runHandlers(first.handlers, "session_start", { type: "session_start" }, firstRun.ctx);
      expect((first.pi as any).__piRogueContextBroker.status().records).toBe(16);
      await first.commands.get("pi-rogue-context").handler("status", firstRun.ctx);
      expect(firstRun.notifications.at(-1)?.message).toContain("batchCommits=1");
      await runHandlers(first.handlers, "session_compact", { type: "session_compact" }, firstRun.ctx);

      const second = createPiMock();
      const secondRun = createCtx(entries);
      await registerContextBrokerBeta(second.pi, { durable: true, storeDir: dir, maxRecords: 16, rewriteThresholdBytes: 1 });
      await runHandlers(second.handlers, "session_start", { type: "session_start" }, secondRun.ctx);
      expect(secondRun.notifications[0]?.message).toContain("Backfilled 0/64");
      expect((second.pi as any).__piRogueContextBroker.status().records).toBe(0);
      await second.commands.get("pi-rogue-context").handler("status", secondRun.ctx);
      expect(secondRun.notifications.at(-1)?.message).toContain("actualPublished=0");
      expect(secondRun.notifications.at(-1)?.message).toContain("batchCommits=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrates only explicit source identity, not parent lineage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-extension-source-lineage-"));
    try {
      const { pi, handlers } = createPiMock();
      const { ctx } = createCtx();
      await registerContextBrokerBeta(pi, { durable: true, storeDir: dir, rewriteThresholdBytes: 1 });
      const bridge = (pi as any).__piRogueContextBroker;
      bridge.publish({
        kind: "tool_output",
        payload: "producer payload",
        sourceId: "producer-a",
        parentIds: ["logical-parent"],
      }, ctx);

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      await runHandlers(handlers, "tool_result", {
        type: "tool_result",
        toolCallId: "logical-parent",
        toolName: "bash",
        content: [{ type: "text", text: "logical parent result" }],
        isError: false,
      }, ctx);

      const artifacts = bridge.lookup({}, ctx);
      expect(artifacts).toHaveLength(2);
      expect(artifacts.find((artifact: any) => artifact.sourceId === "producer-a")).toMatchObject({ parentIds: ["logical-parent"] });
      expect(artifacts.find((artifact: any) => artifact.sourceId === "logical-parent")?.payload).toContain("logical parent result");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purges unpinned broker artifacts after session compaction", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, {
briefBytes: 1200,
    rewriteThresholdBytes: 1
  });
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
    const keepCompletion = commands.get("pi-rogue-context").getArgumentCompletions("pin ", ctx)?.find((item: any) => String(item.description).includes("echo keep"));
    const keepHandle = keepCompletion?.value.replace(/^pin /, "");
    expect(keepHandle).toBeTruthy();
    await commands.get("pi-rogue-context").handler(`pin ${keepHandle}`, ctx);

    await runHandlers(handlers, "session_compact", { type: "session_compact", compactionEntry: { summary: "compact" }, fromExtension: false }, ctx);
    await commands.get("pi-rogue-context").handler("brief", ctx);

    const brief = notifications.at(-1)?.message ?? "";
    expect(brief).toContain("echo keep");
    expect(brief).not.toContain("echo scratch");
    expect(notifications.some((item) => item.message.includes("compact cleanup purged 1 unpinned artifact"))).toBe(true);
  });

  it("is safe on malformed session branches", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx([null, { type: "message", id: "broken", message: null }]);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

    expect(notifications[0].message).toContain("Backfilled 0/0");
  });

  it("does not backfill bash entries explicitly excluded from context", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
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
    await commands.get("pi-rogue-context").handler("brief", ctx);

    expect(notifications[0].message).toContain("Backfilled 0/0");
    expect(notifications.at(-1)?.message).not.toContain("SECRET_TOKEN");
  });

  it("exact lookup returns byte-clipped payloads and marks truncation explicitly", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, {
lookupBytes: 80, searchBytes: 50,
    rewriteThresholdBytes: 1
  });
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

    const lookupCompletion = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0];
    expect(lookupCompletion.value).toMatch(/^lookup ctx:\/\//);

    await commands.get("pi-rogue-context").handler(lookupCompletion.value, ctx);
    const payload = notifications.at(-1)?.message.split("payload:\n").at(-1) ?? "";
    expect(notifications.at(-1)?.message).toContain("payload:");
    expect(payload).toContain("[truncated: omitted");
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(80);
  });

  it("full payload export path writes the full artifact payload", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, {
lookupBytes: 80, searchBytes: 50,
    rewriteThresholdBytes: 1
  });
    const { ctx, notifications } = createCtx();
    const payload = "payload_" + "x".repeat(120) + "::END";

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-export",
      toolName: "bash",
      input: { command: "printf payload" },
      content: [{ type: "text", text: payload }],
      isError: false,
    }, ctx);

    const exportCompletion = commands.get("pi-rogue-context").getArgumentCompletions("export ", ctx)?.[0];
    expect(exportCompletion.value.startsWith("export ctx://")).toBe(true);
    const exportHandle = exportCompletion.value.replace(/^export /, "");

    await commands.get("pi-rogue-context").handler(`export ${exportHandle}`, ctx);

    const message = notifications.at(-1)?.message ?? "";
    const exportPath = message.split(" to ").at(-1) ?? "";
    expect(exportPath).toContain("pi-context-broker-export-");
    expect(exportPath).toMatch(/\.txt$/);
    const exportedPayload = readFileSync(exportPath, "utf8");
    expect(exportedPayload).toContain("tool=bash");
    expect(exportedPayload).toContain(payload);
    rmSync(exportPath);
  });

  it("omits hostile payloads from lookup output and suggests export", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx();
    const payload = `safe\u0000binary${"\u0007".repeat(12)}tail`;

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-hostile",
      toolName: "bash",
      input: { command: "printf host" },
      content: [{ type: "text", text: payload }],
      isError: false,
    }, ctx);

    const lookupCompletion = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0];
    expect(lookupCompletion?.value.startsWith("lookup ctx://")).toBe(true);
    const lookupHandle = lookupCompletion?.value.replace(/^lookup /, "");

    await commands.get("pi-rogue-context").handler(`lookup ${lookupHandle}`, ctx);
    const commandMessage = notifications.at(-1)?.message ?? "";
    expect(commandMessage).toContain("payload intentionally omitted from prompt");
    expect(commandMessage).toContain("/pi-rogue-context export");
    expect(commandMessage).not.toContain("\u0000");
  });

  it("omits opaque printable payloads from lookup output and suggests export", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx();
    const payload = "A".repeat(6000);

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-opaque",
      toolName: "bash",
      input: { command: "printf opaque" },
      content: [{ type: "text", text: payload }],
      isError: false,
    }, ctx);

    const lookupCompletion = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0];
    const lookupHandle = lookupCompletion?.value.replace(/^lookup /, "");

    await commands.get("pi-rogue-context").handler(`lookup ${lookupHandle}`, ctx);
    const commandMessage = notifications.at(-1)?.message ?? "";
    expect(commandMessage).toContain("payload omitted from prompt because it appears opaque/high-token");
    expect(commandMessage).toContain("/pi-rogue-context export");
    expect(commandMessage).not.toContain(payload.slice(0, 200));
  });

  it("does not classify normal multiline code as opaque", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 8000, rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx();
    const payload = Array.from({ length: 240 }, (_, index) => `export function fn${index}() { return ${index}; }`).join("\n");

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-code",
      toolName: "read",
      input: { path: "src/generated.ts" },
      content: [{ type: "text", text: payload }],
      isError: false,
    }, ctx);

    const lookupCompletion = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0];
    const lookupHandle = lookupCompletion?.value.replace(/^lookup /, "");

    await commands.get("pi-rogue-context").handler(`lookup ${lookupHandle}`, ctx);
    const commandMessage = notifications.at(-1)?.message ?? "";
    expect(commandMessage).toContain("export function fn0");
    expect(commandMessage).not.toContain("payload omitted from prompt because it appears opaque/high-token");
  });

  it("text search lookup returns a smaller byte-clipped excerpt", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, {
lookupBytes: 80, searchBytes: 50,
    rewriteThresholdBytes: 1
  });
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

    await commands.get("pi-rogue-context").handler("lookup needle", ctx);
    const payload = notifications.at(-1)?.message.split("payload:\n").at(-1) ?? "";
    expect(notifications.at(-1)?.message).toContain("payload:");
    expect(payload).toContain("[truncated: omitted");
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(50);
  });

  it("sanitizes control characters in context command lookup output", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx();
    const rawPayload = `${"SAFE"}\u0000${"x".repeat(220)}`;

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-control",
      toolName: "bash",
      input: { command: "echo control" },
      content: [{ type: "text", text: rawPayload }],
      isError: false,
    }, ctx);

    const completion = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0];
    await commands.get("pi-rogue-context").handler(completion?.value ?? "", ctx);

    const message = notifications.at(-1)?.message ?? "";
    expect(message).toContain("\\u0000");
    expect(message).not.toContain(String.fromCharCode(0));
  });

  it("context_lookup tool dereferences handles for exact evidence", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, {
lookupBytes: 500,
    rewriteThresholdBytes: 1
  });
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
    const handle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0].value.replace(/^lookup /, "");
    const result = await tools.get("context_lookup").execute("lookup-call", { handle }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain(handle);
    expect(result.content[0].text).toContain("exact evidence payload");
  });

  it("distinguishes exact-handle and text lookup misses", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const toolExactMiss = await tools.get("context_lookup").execute("lookup-missing-handle", { handle: "ctx://missing/handle" }, undefined, undefined, ctx);
    const toolTextMiss = await tools.get("context_lookup").execute("lookup-missing-text", { text: "definitely absent" }, undefined, undefined, ctx);
    await commands.get("pi-rogue-context").handler("lookup ctx://missing/handle", ctx);
    await commands.get("pi-rogue-context").handler("lookup definitely absent", ctx);
    await commands.get("pi-rogue-context").handler("status", ctx);

    expect(toolExactMiss.content[0].text).toContain("exact handle");
    expect(toolTextMiss.content[0].text).toContain("text/filter query");
    expect(notifications.at(-4)?.message).toContain("exact handle");
    expect(notifications.at(-3)?.message).toContain("text/filter query");
    const telemetry = notifications.at(-1)?.message ?? "";
    expect(telemetry).toContain("exactMisses=1");
    expect(telemetry).toContain("textMisses=1");
  });

  it("reports routing telemetry in /pi-rogue-context status", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1, lookupBytes: 500, searchBytes: 500 });
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-tool-telemetry",
      toolName: "bash",
      input: { command: "echo telemetry" },
      content: [{ type: "text", text: "telemetry_payload_" + "x".repeat(200) }],
      isError: false,
    }, ctx);

    const handle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0].value.replace(/^lookup /, "");
    const toolResult = await tools.get("context_lookup").execute("lookup-call", { handle }, undefined, undefined, ctx);
    await commands.get("pi-rogue-context").handler(`lookup ${handle}`, ctx);
    await commands.get("pi-rogue-context").handler(`pin ${handle}`, ctx);
    await commands.get("pi-rogue-context").handler(`export ${handle}`, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [{ role: "toolResult", toolCallId: "tool-result-telemetry", toolName: "bash", content: [{ type: "text", text: "telemetry_payload_" + "y".repeat(1000) }], isError: false, timestamp: 1 }],
    }, ctx);

    await commands.get("pi-rogue-context").handler("status", ctx);

    expect(handle).toBeTruthy();
    expect(toolResult.content[0].text).toContain("telemetry_payload_");
    expect(result).toBeDefined();
    const statusMessage = notifications.at(-2)?.message ?? "";
    expect(statusMessage).toContain("globalCaps=records:unbounded bytes:unbounded");
    const telemetry = notifications.at(-1)?.message ?? "";
    expect(telemetry).toContain("Context broker routing telemetry:");
    expect(telemetry).toContain("rewriteSavings rawBytes=");
    expect(telemetry).toContain("replacementBytes=");
    expect(telemetry).toContain("savedBytes=");
    expect(telemetry).toMatch(/savedBytes=[1-9]\d*/);
    expect(telemetry).toContain("contextLookupHistoryOmitted=");
    expect(telemetry).toContain("lookups tool(calls=");
    expect(telemetry).toContain("exact=");
    expect(telemetry).toContain("textMisses=");
    expect(telemetry).toContain("lookups slash(calls=");
    expect(telemetry).toContain("exports=");
    expect(telemetry).toContain("pins=");
    expect(telemetry).toContain("runtimePublishFailures=");
  });

  it("keeps current context_lookup results visible before the model consumes them", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 1000, rewriteThresholdBytes: 1 });
    const { ctx } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-current-lookup-source",
      toolName: "bash",
      input: { command: "printf current-lookup" },
      content: [{ type: "text", text: "CURRENT_LOOKUP_EVIDENCE_" + "x".repeat(120) }],
      isError: false,
    }, ctx);
    const handle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0].value.replace(/^lookup /, "");
    const lookupResult = await tools.get("context_lookup").execute("lookup-current", { handle }, undefined, undefined, ctx);

    const contextResult = await handlers.get("context")?.[0]({
      type: "context",
      messages: [{ role: "toolResult", toolCallId: "lookup-current", toolName: "context_lookup", content: lookupResult.content, isError: false }],
    }, ctx);

    expect(contextResult).toBeUndefined();
    expect(lookupResult.content[0].text).toContain("CURRENT_LOOKUP_EVIDENCE_");
  });

  it("does not broker historical context_lookup results recursively", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { lookupBytes: 500 });
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
    const handle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0].value.replace(/^lookup /, "");
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
      messages: [
        { role: "toolResult", toolCallId: "lookup-call", toolName: "context_lookup", content: lookupResult.content, isError: false },
        { role: "assistant", content: [{ type: "text", text: "I consumed the lookup." }] },
      ],
    }, ctx);
    await commands.get("pi-rogue-context").handler("brief", ctx);

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
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
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
        "Raw payload omitted from prompt. For exact evidence, call context_lookup with { \"handle\": \"ctx://session/example\" }.",
        "Human/TUI command: /pi-rogue-context lookup ctx://session/example",
      ].join("\n") }],
      isError: false,
    }, ctx);
    await commands.get("pi-rogue-context").handler("brief", ctx);

    expect(notifications.at(-1)?.message).toContain("grep ctx session.log");
  });

  it("context_lookup refuses empty unfocused payload-dumping calls", async () => {
    const { pi, handlers, tools } = createPiMock();
    registerContextBrokerBeta(pi, {
lookupBytes: 500,
    rewriteThresholdBytes: 1
  });
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

  it("allows /pi-rogue-context config threshold to tune rewrite threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-config-test-"));
    const oldHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const { pi, handlers, commands } = createPiMock();
      registerContextBrokerBeta(pi);
      const { ctx, notifications } = createCtx();
      ctx.cwd = dir;

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      await commands.get("pi-rogue-context").handler("status", ctx);
      expect(notifications.at(-2)?.message).toContain("rewriteThresholdBytes=8192(default)");

      await commands.get("pi-rogue-context").handler("config threshold 4096", ctx);
      await commands.get("pi-rogue-context").handler("config", ctx);
      expect(notifications.at(-1)?.message).toContain("rewriteThresholdBytes=4096 (source=config)");
      const raw = "CONFIG_THRESHOLD_" + "x".repeat(5000);
      const result = await handlers.get("context")?.[0]({
        type: "context",
        messages: [
          { role: "toolResult", toolCallId: "configured-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: false, timestamp: 1 },
        ],
      }, ctx);

      expect(result.messages[0].content[0].text).toContain("Context broker artifact: ctx://");
      expect(result.messages[0].content[0].text).not.toContain(raw);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects context threshold values below the healthy minimum", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi);
    const { ctx, notifications } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

    await commands.get("pi-rogue-context").handler("config threshold 1024", ctx);
    expect(notifications.at(-1)?.message).toContain("must be an integer >= 2048 bytes");

    await commands.get("pi-rogue-context").handler("config threshold 0", ctx);
    expect(notifications.at(-1)?.message).toContain("must be an integer >= 2048 bytes");

    await commands.get("pi-rogue-context").handler("config threshold -1", ctx);
    expect(notifications.at(-1)?.message).toContain("must be an integer >= 2048 bytes");
  });

  it("defaults context lenses to off without explicit flag", async () => {
    const oldEnv = process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED;
    try {
      delete process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED;
      const { pi, handlers } = createPiMock();
      registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, contextLensesEnabled: false, lookupBytes: 500 });
      const { ctx } = createCtx();
      const raw = "npm ERR! code ENOTFOUND\nnpm ERR! errno ENOTFOUND\n";

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      const result = await handlers.get("context")?.[0]({
        type: "context",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call-large", name: "bash", arguments: { command: "npm install" } }] },
          { role: "toolResult", toolCallId: "call-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: true, timestamp: 1 },
        ],
      }, ctx);
      const text = result.messages[1].content[0].text;
      expect(text).not.toContain("Package-manager lens");
    } finally {
      if (oldEnv === undefined) delete process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED;
      else process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED = oldEnv;
    }
  });

  it("can turn lenses on via environment variable", async () => {
    const oldEnv = process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED;
    try {
      process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED = "true";
      const { pi, handlers } = createPiMock();
      registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, lookupBytes: 500 });
      const { ctx } = createCtx();
      const raw = "ERROR\nTrace\n" + "x".repeat(200);

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      const result = await handlers.get("context")?.[0]({
        type: "context",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call-large", name: "bash", arguments: { command: "cat /var/log/app.log" } }] },
          { role: "toolResult", toolCallId: "call-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: true, timestamp: 1 },
        ],
      }, ctx);

      expect(result.messages[1].content[0].text).toContain("Log/error lens");
    } finally {
      if (oldEnv === undefined) delete process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED;
      else process.env.PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED = oldEnv;
    }
  });

  it("rewrites large historical tool results in context to live broker handles", async () => {
    const { pi, handlers, tools } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, lookupBytes: 500 });
    const { ctx } = createCtx();
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
    expect(handle).toBeTruthy();
    expect(text).toContain("Context broker artifact: ctx://");
    expect(text).toContain(`call context_lookup with { "handle": "${handle}" }`);
    expect(text).toContain(`/pi-rogue-context lookup ${handle}`);
    expect(text).not.toContain(raw);

    const lookup = await tools.get("context_lookup").execute("lookup-large", { handle }, undefined, undefined, ctx);
    expect(lookup.content[0].text).toContain("RAW_TOOL_OUTPUT_");
  });

  it("rewrites small tool results and leaves excluded bash outputs unchanged in context", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
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

    expect(result?.messages[0].content?.[0]?.text).toContain("Context broker artifact");
    expect(result?.messages[1]).toMatchObject({ role: "bashExecution", output: secret });
  });

  it("uses context lenses for package-manager errors when enabled", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, contextLensesEnabled: true, lookupBytes: 500 });
    const { ctx, notifications } = createCtx();
    const raw = [
      "npm ERR! code ENOTFOUND",
      "npm ERR! errno ENOTFOUND",
      "npm ERR! network request to https://registry.npmjs.org/dep failed",
      "error Command failed with exit code 1.",
      "See https://docs.npmjs.com/cli/v10/commands/npm-install for more information.",
    ].join("\n");

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "call-large", name: "bash", arguments: { command: "npm install" } }] },
        { role: "toolResult", toolCallId: "call-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: true, timestamp: 1 },
      ],
    }, ctx);

    const text = result.messages[1].content[0].text;
    const handle = text.match(/ctx:\/\/\S+/)?.[0];
    expect(text).toContain("Package-manager lens");
    expect(text).toContain("source=npm install");
    expect(text).toContain("ctx://");

    await commands.get("pi-rogue-context").handler(`lookup ${handle}`, ctx);
    expect(notifications.at(-1)?.message).toContain("npm ERR!");
  });

  it("does not apply lenses when disabled by default", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, contextLensesEnabled: false, lookupBytes: 500 });
    const { ctx } = createCtx();
    const raw = [
      "npm ERR! code ENOTFOUND",
      "npm ERR! errno ENOTFOUND",
      "npm ERR! network request to https://registry.npmjs.org/dep failed",
    ].join("\n");

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "call-large", name: "bash", arguments: { command: "npm install" } }] },
        { role: "toolResult", toolCallId: "call-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: true, timestamp: 1 },
      ],
    }, ctx);

    const text = result.messages[1].content[0].text;
    expect(text).toContain("Context broker artifact: ctx://");
    expect(text).toContain("Raw payload omitted from prompt");
    expect(text).not.toContain("Package-manager lens");
    expect(text).not.toContain("npm ERR!");
  });

  it("emits bounded log/error lens snapshots for large error logs", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, contextLensesEnabled: true, lookupBytes: 5000, searchBytes: 5000 });
    const { ctx, notifications } = createCtx();
    const raw = Array.from({ length: 80 }, (_, index) => `ERROR Trace ${index}: failed to process component`);
    const errorLog = raw.join("\n");

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "log-large", name: "bash", arguments: { command: "cat /var/log/app.log" } }] },
        { role: "toolResult", toolCallId: "log-large", toolName: "bash", content: [{ type: "text", text: errorLog }], isError: true, timestamp: 3 },
      ],
    }, ctx);

    const text = result.messages[1].content[0].text;
    const handle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0]?.value.replace(/^lookup /, "");
    expect(text).toContain("Log/error lens");
    expect(text).toContain("source=cat /var/log/app.log");
    expect(text).toContain("Lens view (max 4096 bytes):");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(5000);

    await commands.get("pi-rogue-context").handler(`lookup ${handle}`, ctx);
    expect(notifications.at(-1)?.message).toContain("ERROR Trace 0");
  });

  it("can enable lenses via slash command config", async () => {
    const oldHome = process.env.HOME;
    const testHome = mkdtempSync(join(tmpdir(), "ctx-broker-config-"));
    try {
      process.env.HOME = testHome;
      const { pi, handlers, commands } = createPiMock();
      registerContextBrokerBeta(pi, { rewriteThresholdBytes: 40, lookupBytes: 500 });
      const { ctx } = createCtx();
      const raw = "ERROR at startup\nFAIL at component A\n" + "x".repeat(100);

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      await commands.get("pi-rogue-context").handler("config lenses on", ctx);

      const result = await handlers.get("context")?.[0]({
        type: "context",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call-large", name: "bash", arguments: { command: "tail -n 200 /var/log/sys.log" } }] },
          { role: "toolResult", toolCallId: "call-large", toolName: "bash", content: [{ type: "text", text: raw }], isError: true, timestamp: 1 },
        ],
      }, ctx);

      expect(result.messages[1].content[0].text).toContain("Log/error lens");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(testHome, { recursive: true, force: true });
    }
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

    await commands.get("pi-rogue-context").handler(`lookup ${secondHandle}`, ctx);
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
    expect(result.messages[0].content[0].text).toContain("Context broker artifact pruned before prompt assembly");
    expect(result.messages[0].content[0].text).not.toContain("RAW_0_");

    for (const handle of handles) {
      await commands.get("pi-rogue-context").handler(`lookup ${handle}`, ctx);
      expect(notifications.at(-1)?.message).not.toContain("No context artifacts matched");
      expect(notifications.at(-1)?.message).toContain("RAW_");
    }
  });

  it("does not restore pruned hostile payloads into prompt context", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, {
maxRecords: 1,
    rewriteThresholdBytes: 1
  });
    const { ctx } = createCtx();
    const hostile = `HOSTILE_RAW\u0000${"\u0007".repeat(20)}`;

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [
        { role: "toolResult", toolCallId: "hostile-one", toolName: "bash", content: [{ type: "text", text: hostile }], isError: false, timestamp: 1 },
        { role: "toolResult", toolCallId: "hostile-two", toolName: "bash", content: [{ type: "text", text: `SECOND\u0000${"\u0007".repeat(20)}` }], isError: false, timestamp: 2 },
      ],
    }, ctx);

    const firstText = result.messages[0].content[0].text;
    expect(firstText).toContain("Raw hostile/binary payload omitted from prompt");
    expect(firstText).not.toContain("HOSTILE_RAW");
    expect(firstText).not.toContain("\u0000");
  });

  it("redacts secrets before storing and displaying payloads", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
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

    const lookupCompletion = commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0];
    await commands.get("pi-rogue-context").handler(lookupCompletion.value, ctx);

    expect(notifications.at(-1)?.message).not.toContain("abc123456789");
    expect(notifications.at(-1)?.message).not.toContain("hunter2");
    expect(notifications.at(-1)?.message).not.toContain("object-secret-value");
    expect(notifications.at(-1)?.message).not.toContain("sk-abcdefghijklmnop");
    expect(notifications.at(-1)?.message).toContain("[REDACTED");
  });

  it("preserves a current raw result when its durable source handle was pruned", async () => {
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
    await commands.get("pi-rogue-context").handler("prune", ctx);

    const result = await handlers.get("context")?.[0]({
      type: "context",
      messages: [{ role: "toolResult", toolCallId: "stale-call", toolName: "bash", content: [{ type: "text", text: raw }], isError: false, timestamp: 1 }],
    }, ctx);

    // An unchanged context hook result preserves Pi's current raw message.
    expect(result).toBeUndefined();
  });

  it("can reload artifacts and pin state from durable blob storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-test-"));
    try {
      const first = createPiMock();
      await registerContextBrokerBeta(first.pi, { durable: true, storeDir: dir });
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
      const handle = first.commands.get("pi-rogue-context").getArgumentCompletions("lookup ", ctx)?.[0].value.replace(/^lookup /, "");
      await first.commands.get("pi-rogue-context").handler(`pin ${handle}`, ctx);

      const second = createPiMock();
      const secondRun = createCtx();
      await registerContextBrokerBeta(second.pi, { durable: true, storeDir: dir });
      await runHandlers(second.handlers, "session_start", { type: "session_start" }, secondRun.ctx);
      const secondHandle = second.commands.get("pi-rogue-context").getArgumentCompletions("lookup ", secondRun.ctx)?.[0].value.replace(/^lookup /, "");
      await second.commands.get("pi-rogue-context").handler(`lookup ${handle}`, secondRun.ctx);
      await second.commands.get("pi-rogue-context").handler("brief", secondRun.ctx);
      await second.commands.get("pi-rogue-context").handler("status", secondRun.ctx);

      const third = createPiMock();
      const thirdRun = createCtx();
      await registerContextBrokerBeta(third.pi, { durable: true, storeDir: dir });
      await runHandlers(third.handlers, "session_start", { type: "session_start" }, thirdRun.ctx);
      await third.commands.get("pi-rogue-context").handler(`lookup ${secondHandle}`, thirdRun.ctx);
      await third.commands.get("pi-rogue-context").handler("brief", thirdRun.ctx);

      expect(secondRun.notifications.at(-4)?.message).toContain("durable payload");
      expect(secondRun.notifications.at(-3)?.message).toContain("tier=hot");
      expect(secondRun.notifications.at(-3)?.message).toContain("pinned");
      expect(secondRun.notifications.at(-2)?.message).toContain("globalCaps=records:2048 bytes:268435456");
      expect(thirdRun.notifications.at(-2)?.message).toContain("durable payload");
      expect(thirdRun.notifications.at(-1)?.message).toContain("tier=hot");
      expect(thirdRun.notifications.at(-1)?.message).toContain("pinned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a locked healthy sqlite store and its existing handles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-lock-test-"));
    const path = join(dir, "artifacts.sqlite");
    try {
      const original = createSqliteContextBroker({ path, busyTimeoutMs: 50 });
      const artifact = original.publish({ sessionId: "locked-session", kind: "tool_output", payload: "preserved payload", summary: "preserved" });
      const before = readFileSync(path);
      const lockDb = new DatabaseSync(path);
      try {
        lockDb.exec("BEGIN IMMEDIATE");
        const { pi, handlers } = createPiMock();
        await registerContextBrokerBeta(pi, { durable: true, storeDir: dir });
        const { ctx, notifications } = createCtx();
        await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

        expect(notifications[0]?.type).toBe("warning");
        expect(notifications[0]?.message).toContain("SQLite store is locked");
        expect(notifications[0]?.message).toContain("Store files were preserved");
        expect(readdirSync(dir).some((entry) => entry.includes(".recovered-"))).toBe(false);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path).subarray(0, 16)).toEqual(before.subarray(0, 16));
      } finally {
        lockDb.exec("ROLLBACK");
        lockDb.close();
      }

      const reopened = createSqliteContextBroker({ path });
      expect(reopened.lookup({ handle: artifact.handle })[0]?.payload).toBe("preserved payload");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers locked sqlite compaction without rejecting or discarding artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-compact-lock-test-"));
    const path = join(dir, "artifacts.sqlite");
    try {
      const { pi, handlers, commands } = createPiMock();
      await registerContextBrokerBeta(pi, { durable: true, storeDir: dir, rewriteThresholdBytes: 1 });
      const { ctx, notifications } = createCtx();
      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      await runHandlers(handlers, "tool_result", {
        type: "tool_result",
        toolCallId: "compact-lock-call",
        toolName: "bash",
        input: { command: "echo preserved" },
        content: [{ type: "text", text: "payload preserved across deferred compaction" }],
        isError: false,
      }, ctx);

      const lockDb = new DatabaseSync(path);
      try {
        lockDb.exec("BEGIN IMMEDIATE");
        await expect(runHandlers(handlers, "session_compact", { type: "session_compact" }, ctx)).resolves.toBeUndefined();
        await expect(runHandlers(handlers, "session_compact", { type: "session_compact" }, ctx)).resolves.toBeUndefined();
        const compactWarnings = notifications.filter((entry) => entry.message.includes("cleanup deferred"));
        expect(compactWarnings).toHaveLength(1);
        expect(compactWarnings[0]).toMatchObject({ type: "warning" });
        expect(compactWarnings[0]?.message).toContain("artifacts/source cache preserved");
      } finally {
        lockDb.exec("ROLLBACK");
        lockDb.close();
      }

      expect((pi as any).__piRogueContextBroker.lookup({ text: "payload preserved" }, ctx)).toHaveLength(1);
      await runHandlers(handlers, "tool_result", {
        type: "tool_result",
        toolCallId: "post-compact-lock-call",
        toolName: "bash",
        input: { command: "echo recovered" },
        content: [{ type: "text", text: "publish after compact lock release" }],
        isError: false,
      }, ctx);
      expect(notifications.filter((entry) => entry.message.includes("publish failure"))).toHaveLength(0);
      expect(notifications.filter((entry) => entry.message.includes("preserved original tool/context flow"))).toHaveLength(0);
      await commands.get("pi-rogue-context").handler("status", ctx);
      expect(notifications.at(-1)?.message).toContain("runtimePublishFailures=0");
      expect(notifications.at(-1)?.message).toContain("compactCleanupFailures=2");

      await runHandlers(handlers, "session_compact", { type: "session_compact" }, ctx);
      expect((pi as any).__piRogueContextBroker.lookup({ text: "payload preserved" }, ctx)).toHaveLength(0);
      expect(notifications.at(-1)?.message).toContain("purged 2 unpinned artifacts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("contains locked runtime publishes in tool_result and context hooks, then recovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-runtime-lock-test-"));
    const path = join(dir, "artifacts.sqlite");
    try {
      const { pi, handlers } = createPiMock();
      await registerContextBrokerBeta(pi, { durable: true, storeDir: dir, rewriteThresholdBytes: 1 });
      const { ctx, notifications } = createCtx();
      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      notifications.splice(0);

      const lockDb = new DatabaseSync(path);
      const originalMessage = {
        role: "toolResult",
        toolCallId: "locked-context-call",
        toolName: "bash",
        content: [{ type: "text", text: "runtime payload that must remain in the original flow" }],
        isError: false,
        timestamp: 100,
      };
      try {
        lockDb.exec("BEGIN IMMEDIATE");
        await runHandlers(handlers, "tool_result", { ...originalMessage, type: "tool_result", input: { command: "echo runtime" } }, ctx);
        const contextResult = await handlers.get("context")?.[0]({ type: "context", messages: [originalMessage] }, ctx);

        expect(contextResult).toBeUndefined();
        expect(notifications.filter((entry) => entry.message.includes("preserved original tool/context flow"))).toHaveLength(1);
        expect(notifications.at(-1)?.message).not.toContain("runtime payload");
        expect(readdirSync(dir).some((entry) => entry.includes(".recovered-"))).toBe(false);
      } finally {
        lockDb.exec("ROLLBACK");
        lockDb.close();
      }

      await runHandlers(handlers, "tool_result", {
        type: "tool_result",
        toolCallId: "released-call",
        toolName: "bash",
        input: { command: "echo released" },
        content: [{ type: "text", text: "persisted after release" }],
        isError: false,
        timestamp: 101,
      }, ctx);
      expect((pi as any).__piRogueContextBroker.lookup({ text: "persisted after release" }, ctx)[0]?.payload).toContain("persisted after release");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves sqlite artifacts on unknown non-corruption startup failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-unknown-test-"));
    const sqliteMock = vi.mocked(createSqliteContextBroker);
    const original = sqliteMock.getMockImplementation();
    try {
      const path = join(dir, "artifacts.sqlite");
      writeFileSync(path, "preserve me", "utf8");
      writeFileSync(`${path}-wal`, "preserve wal", "utf8");
      writeFileSync(`${path}-shm`, "preserve shm", "utf8");
      sqliteMock.mockImplementationOnce(() => { throw new Error("permission denied"); });

      const { pi, handlers } = createPiMock();
      await registerContextBrokerBeta(pi, { durable: true, storeDir: dir });
      const { ctx, notifications } = createCtx();
      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

      expect(notifications[0]?.message).toContain("non-corruption SQLite startup failure");
      expect(readFileSync(path, "utf8")).toBe("preserve me");
      expect(readFileSync(`${path}-wal`, "utf8")).toBe("preserve wal");
      expect(readFileSync(`${path}-shm`, "utf8")).toBe("preserve shm");
      expect(readdirSync(dir).some((entry) => entry.includes(".recovered-"))).toBe(false);
    } finally {
      if (original) sqliteMock.mockImplementation(original);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and repairs durable sqlite when the store can be quarantined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-test-"));
    try {
      writeFileSync(join(dir, "artifacts.sqlite"), "not sqlite");
      const { pi, handlers } = createPiMock();
      await registerContextBrokerBeta(pi, { durable: true, storeDir: dir });
      const { ctx, notifications } = createCtx();

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);

      expect(notifications[0]?.type).toBe("warning");
      expect(notifications[0]?.message).toContain("durability repaired");
      expect(notifications[0]?.message).toContain("fresh SQLite store");
      expect(readdirSync(dir).some((entry) => entry.includes("artifacts.sqlite.recovered-") || entry.includes("artifacts.sqlite-wal.recovered-") || entry.includes("artifacts.sqlite-shm.recovered-"))).toBe(true);
      expect(existsSync(join(dir, "artifacts.sqlite"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to in-memory when sqlite recovery keeps failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-broker-test-"));
    const sqliteMock = vi.mocked(createSqliteContextBroker);
    const original = sqliteMock.getMockImplementation();
    try {
      writeFileSync(join(dir, "artifacts.sqlite"), "not sqlite");
      sqliteMock
        .mockImplementationOnce(() => { throw new Error("file is not a database"); })
        .mockImplementationOnce(() => { throw new Error("still broken after quarantine"); });

      const { pi, handlers, commands } = createPiMock();
      await registerContextBrokerBeta(pi, { durable: true, storeDir: dir });
      const { ctx, notifications } = createCtx();

      await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
      await commands.get("pi-rogue-context").handler("status", ctx);

      expect(notifications[0]?.type).toBe("warning");
      expect(notifications[0]?.message).toContain("in-memory broker");
      expect(notifications.some((item) => item.message.includes("backend=memory(degraded), path=none"))).toBe(true);
      expect(readdirSync(dir).some((entry) => entry.includes("artifacts.sqlite.recovered-") || entry.includes("artifacts.sqlite-wal.recovered-") || entry.includes("artifacts.sqlite-shm.recovered-"))).toBe(true);
      expect(existsSync(join(dir, "artifacts.sqlite"))).toBe(false);
    } finally {
      if (original) sqliteMock.mockImplementation(original);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not inject broker guidance when no handles are present", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const { ctx } = createCtx();

    await runHandlers(handlers, "session_start", { type: "session_start" }, ctx);
    const result = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);

    expect(result).toBeUndefined();
  });

  it("keeps source-id deduplication isolated across sessions", async () => {
    const { pi, handlers, commands } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const first = createCtx([{ type: "message", id: "entry-a", message: { role: "toolResult", toolCallId: "shared-call", toolName: "bash", content: [{ type: "text", text: "payload-from-A" }], isError: false } }]);
    first.ctx.sessionManager.getSessionFile = () => "/sessions/a.jsonl";
    const second = createCtx([{ type: "message", id: "entry-b", message: { role: "toolResult", toolCallId: "shared-call", toolName: "bash", content: [{ type: "text", text: "payload-from-B" }], isError: false } }]);
    second.ctx.sessionManager.getSessionFile = () => "/sessions/b.jsonl";

    await runHandlers(handlers, "session_start", { type: "session_start" }, first.ctx);
    await runHandlers(handlers, "session_start", { type: "session_start" }, first.ctx);
    expect(first.notifications[0]?.message).toContain("Backfilled 1/1");
    expect(first.notifications[1]?.message).toContain("Backfilled 0/1");

    await runHandlers(handlers, "session_start", { type: "session_start" }, second.ctx);
    await commands.get("pi-rogue-context").handler("lookup payload-from-B", second.ctx);

    expect(second.notifications.at(-1)?.message).toContain("payload-from-B");
    expect(second.notifications.at(-1)?.message).not.toContain("payload-from-A");
  });

  it("keeps alternating session prompt briefs and non-exact lookups isolated", async () => {
    const { pi, handlers, commands, tools } = createPiMock();
    registerContextBrokerBeta(pi, { rewriteThresholdBytes: 1 });
    const first = createCtx();
    first.ctx.sessionManager.getSessionFile = () => "/sessions/a.jsonl";
    const second = createCtx();
    second.ctx.sessionManager.getSessionFile = () => "/sessions/b.jsonl";

    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-a",
      toolName: "bash",
      input: { command: "echo SESSION_A_SECRET_MARKER" },
      content: [{ type: "text", text: "payload-a" }],
      isError: false,
    }, first.ctx);
    const aHandle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ")?.[0]?.value.replace(/^lookup /, "");

    await runHandlers(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-b",
      toolName: "bash",
      input: { command: "echo SESSION_B_SECRET_MARKER" },
      content: [{ type: "text", text: "payload-b" }],
      isError: false,
    }, second.ctx);
    const bHandle = commands.get("pi-rogue-context").getArgumentCompletions("lookup ")?.[0]?.value.replace(/^lookup /, "");

    const aPrompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base-a" }, first.ctx);
    const aCompletions = commands.get("pi-rogue-context").getArgumentCompletions("lookup ")?.map((item: any) => item.value) ?? [];
    const bPrompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base-b" }, second.ctx);
    const bCompletions = commands.get("pi-rogue-context").getArgumentCompletions("lookup ")?.map((item: any) => item.value) ?? [];
    const aLookup = await tools.get("context_lookup").execute("lookup-a", { text: "SESSION_A_SECRET_MARKER" }, undefined, undefined, first.ctx);
    const bLookup = await tools.get("context_lookup").execute("lookup-b", { text: "SESSION_B_SECRET_MARKER" }, undefined, undefined, second.ctx);

    expect(aHandle).toBeTruthy();
    expect(bHandle).toBeTruthy();
    expect(aPrompt.systemPrompt).toContain(aHandle);
    expect(aPrompt.systemPrompt).not.toContain(bHandle);
    expect(aPrompt.systemPrompt).toContain("SESSION_A_SECRET_MARKER");
    expect(aPrompt.systemPrompt).not.toContain("SESSION_B_SECRET_MARKER");
    expect(bPrompt.systemPrompt).toContain(bHandle);
    expect(bPrompt.systemPrompt).not.toContain(aHandle);
    expect(bPrompt.systemPrompt).toContain("SESSION_B_SECRET_MARKER");
    expect(bPrompt.systemPrompt).not.toContain("SESSION_A_SECRET_MARKER");
    expect(aLookup.content[0].text).toContain("SESSION_A_SECRET_MARKER");
    expect(aLookup.content[0].text).not.toContain("SESSION_B_SECRET_MARKER");
    expect(bLookup.content[0].text).toContain("SESSION_B_SECRET_MARKER");
    expect(bLookup.content[0].text).not.toContain("SESSION_A_SECRET_MARKER");
    expect(aCompletions).toContain(`lookup ${aHandle}`);
    expect(aCompletions).not.toContain(`lookup ${bHandle}`);
    expect(bCompletions).toContain(`lookup ${bHandle}`);
    expect(bCompletions).not.toContain(`lookup ${aHandle}`);
  });

  it("injects a bounded broker brief without raw payload text", async () => {
    const { pi, handlers } = createPiMock();
    registerContextBrokerBeta(pi, {
briefBytes: 220,
    rewriteThresholdBytes: 1
  });
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
    expect(result.systemPrompt).toContain("context_lookup");
    expect(result.systemPrompt).toContain("/pi-rogue-context lookup is human/TUI only");
    expect(result.systemPrompt).not.toContain("SECRET_TOKEN");
  });
});
