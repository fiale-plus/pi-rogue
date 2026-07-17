import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readWorkerState } from "./worker.js";

const RPC_VERSION = 1;
const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_REPLY_TIMEOUT_MS = 15_000;

type WorkerDispatchParams = {
  task: string;
  model?: string;
  agent?: string;
  cwd?: string;
  timeoutMs?: number;
  turnBudget?: { maxTurns: number; graceTurns?: number };
  toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
};

export type WorkerDispatchResult = {
  requestId: string;
  runId?: string;
  asyncDir?: string;
  text: string;
  details?: unknown;
};

function parseModelRef(value: string): { provider: string; model: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function resolveConfiguredWorkerModel(ctx: any, modelRef: string): unknown {
  const parsed = parseModelRef(modelRef);
  if (!parsed) throw new Error("Worker model must use the <provider>/<model> form.");
  const model = ctx?.modelRegistry?.find?.(parsed.provider, parsed.model);
  if (!model) throw new Error(`Worker model is not configured or available: ${modelRef}`);
  return model;
}

function detailValue(details: any, key: string): unknown {
  return details && typeof details === "object" ? details[key] : undefined;
}

export async function dispatchWorker(
  pi: Pick<ExtensionAPI, "events">,
  ctx: any,
  params: WorkerDispatchParams,
  signal?: AbortSignal,
  options?: { acknowledgementTimeoutMs?: number },
): Promise<WorkerDispatchResult> {
  const task = params.task.trim();
  if (!task) throw new Error("Worker task must not be empty.");
  const state = readWorkerState(ctx);
  if (!state.enabled || !state.model) throw new Error("Worker dispatch requires explicit opt-in via /pi-rogue-orchestration worker use <provider>/<model>.");
  const model = params.model?.trim() || state.model;
  resolveConfiguredWorkerModel(ctx, model);

  const requestId = randomUUID();
  const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
  const events = (pi as any).events;
  if (!events || typeof events.emit !== "function" || typeof events.on !== "function") {
    throw new Error("The pi-subagents RPC bridge is unavailable in this session.");
  }

  return await new Promise<WorkerDispatchResult>((resolve, reject) => {
    let settled = false;
    let runId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      if (runId) events.emit(RPC_REQUEST, { version: RPC_VERSION, requestId: randomUUID(), method: "stop", params: { runId }, source: { extension: "pi-rogue-orchestration" } });
      finish(() => reject(new Error("Worker dispatch cancelled.")));
    };
    unsubscribe = events.on(replyEvent, (raw: any) => {
      if (!raw || raw.requestId !== requestId) return;
      if (!raw.success) {
        finish(() => reject(new Error(raw.error?.message || "Worker dispatch failed.")));
        return;
      }
      const data = raw.data ?? {};
      const details = data.details;
      runId = typeof detailValue(details, "runId") === "string" ? detailValue(details, "runId") as string : undefined;
      finish(() => resolve({ requestId, runId, asyncDir: typeof detailValue(details, "asyncDir") === "string" ? detailValue(details, "asyncDir") as string : undefined, text: typeof data.text === "string" ? data.text : "", details }));
    });
    const acknowledgementTimeoutMs = options?.acknowledgementTimeoutMs ?? RPC_REPLY_TIMEOUT_MS;
    timer = setTimeout(() => finish(() => reject(new Error(`Worker dispatch acknowledgement timed out after ${acknowledgementTimeoutMs}ms.`))), acknowledgementTimeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    events.emit(RPC_REQUEST, {
      version: RPC_VERSION,
      requestId,
      method: "spawn",
      params: {
        agent: params.agent ?? "local-worker-poc",
        task,
        model,
        cwd: params.cwd ?? ctx.cwd,
        async: true,
        clarify: false,
        timeoutMs: params.timeoutMs,
        turnBudget: params.turnBudget,
        toolBudget: params.toolBudget,
        context: "fresh",
        artifacts: true,
        includeProgress: true,
        acceptance: "none",
      },
      source: { extension: "pi-rogue-orchestration" },
    });
  });
}
