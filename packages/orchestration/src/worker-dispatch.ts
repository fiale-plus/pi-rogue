import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routerEventsPath } from "@fiale-plus/pi-rogue-router";
import { readWorkerState } from "./worker.js";
import { classifyWorkerOutcome, recordWorkerRequest, recordWorkerResult } from "./worker-telemetry.js";

const RPC_VERSION = 1;
const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_REPLY_TIMEOUT_MS = 15_000;
const STATUS_POLL_MS = 250;
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "paused", "stopped", "interrupted", "cancelled"]);

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

type DispatchOptions = {
  acknowledgementTimeoutMs?: number;
  /** Wait for the async worker to reach a terminal state instead of returning after spawn acknowledgement. */
  waitForCompletion?: boolean;
  telemetry?: { parentSessionId: string; ledgerPath?: string };
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
  options?: DispatchOptions,
): Promise<WorkerDispatchResult> {
  const task = params.task.trim();
  if (!task) throw new Error("Worker task must not be empty.");
  const state = readWorkerState(ctx);
  if (!state.enabled || !state.model) throw new Error("Worker dispatch requires explicit opt-in via /pi-rogue-orchestration worker use <provider>/<model>.");
  const model = params.model?.trim() || state.model;
  resolveConfiguredWorkerModel(ctx, model);

  const requestId = randomUUID();
  const spawnExecutionId = `rpc-spawn-${requestId}`;
  const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
  const events = (pi as any).events;
  if (!events || typeof events.emit !== "function" || typeof events.on !== "function") {
    throw new Error("The pi-subagents RPC bridge is unavailable in this session.");
  }

  const telemetry = options?.telemetry;
  const ledgerPath = telemetry?.ledgerPath ?? routerEventsPath(ctx);
  let telemetryRecorded = false;
  if (telemetry) {
    try {
      recordWorkerRequest({
        parentSessionId: telemetry.parentSessionId,
        childSessionId: requestId,
        ledgerPath,
        model,
        inputSummary: task,
      });
      telemetryRecorded = true;
    } catch {
      // Telemetry must remain observe-only and never prevent a bounded dispatch.
    }
  }

  return await new Promise<WorkerDispatchResult>((resolve, reject) => {
    let settled = false;
    let runId: string | undefined;
    let asyncDir: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const startedAt = Date.now();
    const stop = (): void => {
      events.emit(RPC_REQUEST, {
        version: RPC_VERSION,
        requestId: randomUUID(),
        method: "stop",
        // The deterministic RPC execution id also resolves the run if spawn ack is lost.
        params: runId ? { runId } : { id: spawnExecutionId },
        source: { extension: "pi-rogue-orchestration" },
      });
    };
    const finish = (fn: () => void, outcome?: ReturnType<typeof classifyWorkerOutcome>, outputSummary?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      if (telemetryRecorded && outcome) {
        try {
          recordWorkerResult({ childSessionId: requestId, ledgerPath, outcome, outputSummary, elapsedMs: Date.now() - startedAt });
        } catch {
          // Best-effort ledger writes must not alter worker control flow.
        }
      }
      fn();
    };
    const onAbort = (): void => {
      stop();
      finish(() => reject(new Error("Worker dispatch cancelled.")), classifyWorkerOutcome({ abandoned: true }), "Worker dispatch cancelled.");
    };
    const pollStatus = (): void => {
      if (settled || !runId) return;
      const statusRequestId = randomUUID();
      const statusEvent = `${RPC_REPLY_PREFIX}${statusRequestId}`;
      let statusTimer: ReturnType<typeof setTimeout> | undefined;
      const removeStatusListener = events.on(statusEvent, (raw: any) => {
        if (!raw || raw.requestId !== statusRequestId) return;
        if (statusTimer) clearTimeout(statusTimer);
        removeStatusListener?.();
        if (!raw.success) {
          finish(() => reject(new Error(raw.error?.message || "Worker status failed.")), classifyWorkerOutcome({ hasError: true }), raw.error?.message);
          return;
        }
        const data = raw.data ?? {};
        const statusDetails = data.details ?? data;
        const status = String(detailValue(statusDetails, "state") ?? detailValue(statusDetails, "status") ?? "").toLowerCase();
        if (TERMINAL_STATES.has(status)) {
          const failed = status === "failed" || status === "stopped" || status === "interrupted" || status === "cancelled";
          finish(
            () => resolve({ requestId, runId, asyncDir, text: typeof data.text === "string" ? data.text : "", details: statusDetails }),
            classifyWorkerOutcome({ hasError: failed, hasOutput: !failed }),
            typeof data.text === "string" ? data.text : status,
          );
          return;
        }
        pollTimer = setTimeout(pollStatus, STATUS_POLL_MS);
      });
      statusTimer = setTimeout(() => {
        removeStatusListener?.();
        if (!settled) pollTimer = setTimeout(pollStatus, STATUS_POLL_MS);
      }, Math.min(5_000, Math.max(500, options?.acknowledgementTimeoutMs ?? RPC_REPLY_TIMEOUT_MS)));
      events.emit(RPC_REQUEST, {
        version: RPC_VERSION,
        requestId: statusRequestId,
        method: "status",
        params: { runId },
        source: { extension: "pi-rogue-orchestration" },
      });
    };
    unsubscribe = events.on(replyEvent, (raw: any) => {
      if (!raw || raw.requestId !== requestId) return;
      if (!raw.success) {
        finish(() => reject(new Error(raw.error?.message || "Worker dispatch failed.")), classifyWorkerOutcome({ hasError: true }), raw.error?.message);
        return;
      }
      const data = raw.data ?? {};
      const details = data.details;
      runId = typeof detailValue(details, "runId") === "string" ? detailValue(details, "runId") as string : undefined;
      asyncDir = typeof detailValue(details, "asyncDir") === "string" ? detailValue(details, "asyncDir") as string : undefined;
      if (options?.waitForCompletion && runId) {
        if (timer) clearTimeout(timer);
        const workerTimeoutMs = params.timeoutMs ?? 900_000;
        timer = setTimeout(() => {
          stop();
          finish(() => reject(new Error(`Worker dispatch timed out after ${workerTimeoutMs}ms.`)), classifyWorkerOutcome({ timedOut: true }), "Worker dispatch timed out.");
        }, workerTimeoutMs);
        pollStatus();
        return;
      }
      finish(
        () => resolve({ requestId, runId, asyncDir, text: typeof data.text === "string" ? data.text : "", details }),
        classifyWorkerOutcome({ hasOutput: Boolean(data.text), isPartial: Boolean(runId) }),
        typeof data.text === "string" ? data.text : "Worker started.",
      );
    });
    const acknowledgementTimeoutMs = options?.acknowledgementTimeoutMs ?? RPC_REPLY_TIMEOUT_MS;
    timer = setTimeout(() => {
      stop();
      finish(() => reject(new Error(`Worker dispatch acknowledgement timed out after ${acknowledgementTimeoutMs}ms.`)), classifyWorkerOutcome({ timedOut: true }), "Worker dispatch acknowledgement timed out.");
    }, acknowledgementTimeoutMs);
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
