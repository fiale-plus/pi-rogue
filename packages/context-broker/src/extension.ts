import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createInMemoryContextBroker } from "./index.js";

export interface ContextBrokerBetaOptions {
  enabled?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  briefBytes?: number;
  lookupBytes?: number;
  searchBytes?: number;
}

type UiLike = { notify(message: string, type?: "info" | "warning" | "error"): void; setStatus?(key: string, text: string | undefined): void };
type SessionContextLike = Pick<ExtensionContext, "cwd" | "sessionManager"> & { ui: UiLike };

const DEFAULT_BRIEF_BYTES = 1_800;
const DEFAULT_LOOKUP_BYTES = 12_000;
const DEFAULT_SEARCH_BYTES = 2_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnvEnabled(): boolean {
  return ENABLED_VALUES.has(String(process.env.PI_CONTEXT_BROKER_ENABLED ?? "").trim().toLowerCase());
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;
  if (limit === 0) return "";

  let omittedBytes = totalBytes;
  let result = "";
  let marker = "…";

  for (let pass = 0; pass < 4; pass += 1) {
    const verboseMarker = `\n[truncated: omitted ${omittedBytes} bytes]`;
    marker = Buffer.byteLength(verboseMarker, "utf8") < limit ? verboseMarker : "…";
    const contentLimit = Math.max(0, limit - Buffer.byteLength(marker, "utf8"));
    let used = 0;
    let prefix = "";

    for (const char of text) {
      const bytes = Buffer.byteLength(char, "utf8");
      if (used + bytes > contentLimit) break;
      prefix += char;
      used += bytes;
    }

    result = prefix;
    const nextOmittedBytes = totalBytes - used;
    if (nextOmittedBytes === omittedBytes) break;
    omittedBytes = nextOmittedBytes;
  }

  return `${result}${marker}`;
}

function compact(value: string, max = 120): string {
  return truncateUtf8(value.replace(/\s+/g, " ").trim(), max);
}

function sessionIdFor(ctx: Partial<SessionContextLike>): string {
  const file = ctx.sessionManager?.getSessionFile?.();
  return file || ctx.cwd || process.cwd();
}

function messageTimestamp(entry: any): number | undefined {
  const value = entry?.message?.timestamp ?? entry?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toolPayload(event: { toolName: string; input?: unknown; content?: unknown; details?: unknown; isError?: boolean }): string {
  return [
    `tool=${event.toolName}`,
    `isError=${Boolean(event.isError)}`,
    "input:",
    toText(event.input),
    "content:",
    toText(event.content),
    "details:",
    toText(event.details),
  ].join("\n");
}

function summarizeTool(event: { toolName: string; input?: any; isError?: boolean }, bytes: number): string {
  const command = event.toolName === "bash" ? event.input?.command : undefined;
  const path = event.input?.path;
  const target = command ? ` command=${compact(String(command), 120)}` : path ? ` path=${path}` : "";
  return `${event.isError ? "failed" : "completed"} ${event.toolName}${target}; payload=${bytes} bytes`;
}

export function registerContextBrokerBeta(pi: ExtensionAPI, options: ContextBrokerBetaOptions = {}): void {
  const p = pi as any;
  if (p.__piRogueContextBrokerBetaRegistered) return;
  p.__piRogueContextBrokerBetaRegistered = true;

  const briefBytes = options.briefBytes ?? DEFAULT_BRIEF_BYTES;
  const lookupBytes = options.lookupBytes ?? DEFAULT_LOOKUP_BYTES;
  const searchBytes = options.searchBytes ?? DEFAULT_SEARCH_BYTES;
  const broker = createInMemoryContextBroker({
    maxRecords: options.maxRecords ?? 64,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    briefBytes,
  });
  const seenSourceIds = new Set<string>();
  let activeSessionId = process.cwd();

  function currentBrief(): string {
    return broker.renderBrief({ sessionId: activeSessionId, budgetBytes: briefBytes });
  }

  function publishToolArtifact(event: {
    toolName: string;
    input?: any;
    content?: unknown;
    details?: unknown;
    isError?: boolean;
    sourceId?: string;
    createdAt?: number;
  }): boolean {
    if (event.sourceId) {
      if (seenSourceIds.has(event.sourceId)) return false;
      seenSourceIds.add(event.sourceId);
    }

    const payload = toolPayload(event);
    const bytes = Buffer.byteLength(payload, "utf8");
    broker.publish({
      sessionId: activeSessionId,
      kind: "tool_output",
      payload,
      summary: summarizeTool(event, bytes),
      tags: [event.toolName, event.isError ? "error" : "ok", event.sourceId ? "session-backfill" : "live"],
      command: event.toolName === "bash" && typeof event.input?.command === "string" ? event.input.command : undefined,
      paths: typeof event.input?.path === "string" ? [event.input.path] : [],
      ttlMs: DEFAULT_TTL_MS,
      parentIds: event.sourceId ? [event.sourceId] : [],
      createdAt: event.createdAt,
    });
    return true;
  }

  function backfillSessionArtifacts(ctx: Partial<SessionContextLike>): { added: number; scanned: number; errors: number } {
    activeSessionId = sessionIdFor(ctx);
    let entries: any[] = [];
    try {
      entries = ctx.sessionManager?.getBranch?.() ?? [];
    } catch {
      return { added: 0, scanned: 0, errors: 1 };
    }

    const toolInputs = new Map<string, { toolName?: string; input?: unknown }>();
    for (const entry of entries) {
      const message = entry?.type === "message" ? entry.message : undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          toolInputs.set(block.id, { toolName: typeof block.name === "string" ? block.name : undefined, input: block.arguments });
        }
      }
    }

    let added = 0;
    let scanned = 0;
    let errors = 0;

    for (const entry of entries) {
      try {
        const entryId = typeof entry?.id === "string" ? entry.id : undefined;
        const createdAt = messageTimestamp(entry);

        if (entry?.type === "message" && entry.message?.role === "toolResult") {
          scanned += 1;
          const sourceId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : entryId;
          const toolInput = sourceId ? toolInputs.get(sourceId) : undefined;
          if (publishToolArtifact({
            toolName: String(entry.message.toolName ?? toolInput?.toolName ?? "tool"),
            input: entry.message.input ?? toolInput?.input,
            content: entry.message.content,
            details: entry.message.details,
            isError: Boolean(entry.message.isError),
            sourceId,
            createdAt,
          })) added += 1;
        }

        if (entry?.type === "message" && entry.message?.role === "bashExecution") {
          if (entry.message.excludeFromContext === true) continue;
          scanned += 1;
          const sourceId = entryId;
          if (publishToolArtifact({
            toolName: "bash",
            input: { command: entry.message.command },
            content: entry.message.output,
            details: {
              exitCode: entry.message.exitCode,
              cancelled: entry.message.cancelled,
              truncated: entry.message.truncated,
              fullOutputPath: entry.message.fullOutputPath,
            },
            isError: typeof entry.message.exitCode === "number" ? entry.message.exitCode !== 0 : Boolean(entry.message.cancelled),
            sourceId,
            createdAt,
          })) added += 1;
        }
      } catch {
        errors += 1;
      }
    }

    return { added, scanned, errors };
  }

  const contextActions: AutocompleteItem[] = [
    { value: "status", label: "status", description: "Show broker record, byte, and pinned counts" },
    { value: "brief", label: "brief", description: "Show the bounded broker brief" },
    { value: "lookup ", label: "lookup", description: "Lookup by ctx:// handle or current-session text" },
    { value: "pin ", label: "pin", description: "Pin an artifact by ctx:// handle or id" },
    { value: "prune", label: "prune", description: "Run TTL/cap pruning now" },
  ];

  function artifactCompletions(action: "lookup" | "pin", query: string): AutocompleteItem[] {
    const needle = query.trim().toLowerCase();
    return broker.lookup({ sessionId: activeSessionId, limit: 10 })
      .filter((artifact) => {
        if (!needle) return true;
        return artifact.handle.toLowerCase().includes(needle)
          || artifact.summary.toLowerCase().includes(needle)
          || artifact.kind.toLowerCase().includes(needle)
          || artifact.tags.join(" ").toLowerCase().includes(needle)
          || artifact.paths.join(" ").toLowerCase().includes(needle);
      })
      .map((artifact) => ({
        value: `${action} ${artifact.handle}`,
        label: `${action} ${artifact.kind}`,
        description: `${artifact.pinned ? "pinned; " : ""}${artifact.summary}`,
      }));
  }

  function contextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    const prefix = argumentPrefix.trimStart();
    const [action = "", ...restParts] = prefix.split(/\s+/);
    const hasActionSeparator = /\s/.test(prefix);

    if (!action || !hasActionSeparator) {
      const items = contextActions.filter((item) => item.value.trim().startsWith(action));
      return items.length ? items : contextActions;
    }

    if (action === "lookup" || action === "pin") {
      const items = artifactCompletions(action, restParts.join(" "));
      return items.length ? items : null;
    }

    return null;
  }

  pi.on("session_start", async (_event, ctx) => {
    const { added, scanned, errors } = backfillSessionArtifacts(ctx);
    ctx.ui.setStatus?.("context-broker", "ctx:on beta");
    ctx.ui.notify(
      `Context broker beta enabled. Backfilled ${added}/${scanned} current-branch tool artifacts${errors ? ` (${errors} malformed skipped)` : ""}. Use /context status or /context brief.`,
      errors ? "warning" : "info",
    );
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    activeSessionId = sessionIdFor(ctx);
    publishToolArtifact({ ...event, sourceId: event.toolCallId });
  });

  pi.on("before_agent_start", async (event) => {
    const brief = currentBrief();
    if (!brief.includes("ctx://")) return;
    return {
      systemPrompt: [
        event.systemPrompt,
        brief,
        "Context broker beta rule: use /context lookup <handle> for exact evidence when a broker handle is relevant. Broker briefs are bounded summaries and never raw payload dumps.",
      ].join("\n\n"),
    };
  });

  pi.registerCommand("context", {
    description: "Inspect the beta context broker: status | brief | lookup <handle-or-text> | pin <handle> | prune",
    getArgumentCompletions: contextArgumentCompletions,
    handler: async (args, ctx) => {
      activeSessionId = sessionIdFor(ctx);
      const [action = "status", ...rest] = String(args || "").trim().split(/\s+/).filter(Boolean);
      const query = rest.join(" ");

      if (action === "status") {
        const status = broker.status();
        ctx.ui.notify(
          `Context broker beta: enabled, session=${activeSessionId}, records=${status.records}, bytes=${status.bytes}/${status.maxBytes}, pinned=${status.pinnedRecords}/${status.pinnedBytes} bytes`,
          "info",
        );
        return;
      }

      if (action === "brief") {
        ctx.ui.notify(currentBrief(), "info");
        return;
      }

      if (action === "lookup") {
        if (!query) {
          ctx.ui.notify("Usage: /context lookup <ctx://handle-or-text>", "warning");
          return;
        }
        const exact = query.startsWith("ctx://");
        const results = broker.lookup(exact ? { handle: query } : { sessionId: activeSessionId, text: query, limit: 5 });
        ctx.ui.notify(results.length ? results.map((item) => [
          item.handle,
          `kind=${item.kind} bytes=${item.bytes}`,
          `summary=${item.summary}`,
          "payload:",
          truncateUtf8(item.payload, exact ? lookupBytes : searchBytes),
        ].join("\n")).join("\n\n---\n\n") : "No context artifacts matched.", "info");
        return;
      }

      if (action === "pin") {
        if (!query) {
          ctx.ui.notify("Usage: /context pin <ctx://handle-or-id>", "warning");
          return;
        }
        const pinned = broker.pin(query, true);
        ctx.ui.notify(pinned ? `Pinned ${pinned.handle}` : "No artifact matched that handle/id.", pinned ? "info" : "warning");
        return;
      }

      if (action === "prune") {
        const status = broker.prune();
        ctx.ui.notify(`Pruned. ${status.records} records, ${status.bytes} bytes remain.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /context status | brief | lookup <handle-or-text> | pin <handle> | prune", "warning");
    },
  });
}

export function shouldEnableContextBrokerBeta(options: ContextBrokerBetaOptions = {}): boolean {
  return Boolean(options.enabled ?? isEnvEnabled());
}
