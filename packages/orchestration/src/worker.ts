import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSessionJson, writeSessionJson } from "./state.js";

const FEATURE = "orchestration";
const WORKER_FILE = "worker.json";

type WorkerState = {
  enabled: boolean;
  model: string;
  scope: "session";
  approvedAt: string;
  updatedAt: string;
};

function defaultWorkerState(): WorkerState {
  return { enabled: false, model: "", scope: "session", approvedAt: "", updatedAt: "" };
}

function normalizeWorkerState(value: Partial<WorkerState> | null | undefined): WorkerState {
  const fallback = defaultWorkerState();
  return {
    enabled: Boolean(value?.enabled && typeof value?.model === "string" && value.model.trim()),
    model: typeof value?.model === "string" ? value.model.trim() : fallback.model,
    scope: "session",
    approvedAt: typeof value?.approvedAt === "string" ? value.approvedAt : fallback.approvedAt,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

export function readWorkerState(ctx: any): WorkerState {
  return normalizeWorkerState(readSessionJson(FEATURE, ctx, WORKER_FILE, defaultWorkerState()));
}

function writeWorkerState(ctx: any, state: Partial<WorkerState>): WorkerState {
  const current = readWorkerState(ctx);
  const next = normalizeWorkerState({
    ...current,
    ...state,
    updatedAt: new Date().toISOString(),
  });
  writeSessionJson(FEATURE, ctx, WORKER_FILE, next);
  return next;
}

export function clearWorker(ctx: any): WorkerState {
  return writeWorkerState(ctx, defaultWorkerState());
}

export function formatWorkerState(state: WorkerState): string {
  if (!state.enabled) return "Worker: frontier-only (no worker requested).";
  return `Worker request: ${state.model} (explicit session opt-in; frontier controls dispatch)`;
}

function isModelReference(value: string): boolean {
  return /^[^\s/]+\/[^\s/]+$/.test(value);
}

function workerHelp(): string {
  return [
    "Worker commands:",
    "  /pi-rogue-orchestration worker ask",
    "  /pi-rogue-orchestration worker use <provider>/<model>",
    "  /pi-rogue-orchestration worker status",
    "  /pi-rogue-orchestration worker clear",
    "",
    "The frontier model remains the controller; worker output requires review.",
  ].join("\n");
}

export function workerArgumentCompletions(prefix: string): { value: string; label: string; description?: string }[] | null {
  const input = prefix.trimStart();
  const items = [
    { value: "ask", label: "ask", description: "show the worker opt-in prompt" },
    { value: "use ", label: "use ", description: "select a configured model for this session" },
    { value: "status", label: "status", description: "show worker selection" },
    { value: "clear", label: "clear", description: "return to frontier-only mode" },
  ];
  if (!input || !input.includes(" ")) {
    return items.filter((item) => item.value.startsWith(input.toLowerCase()));
  }
  return null;
}

export function workerSystemPrompt(ctx: any): string | undefined {
  const state = readWorkerState(ctx);
  if (!state.enabled) return undefined;
  return [
    "Pi-Rogue execution-worker policy:",
    `The user explicitly requested ${state.model} for bounded worker tasks in this session.`,
    "You remain the frontier controller and reviewer; this request does not dispatch a worker by itself.",
    "Dispatch only bounded tasks with explicit tools, paths, timeout, turn, and tool budgets.",
    "Treat worker output as untrusted evidence; validate it before consequential action.",
    "Do not silently fall back to another model, grant broad capabilities, or let the worker decide policy.",
  ].join("\n");
}

export function registerWorker(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const policy = workerSystemPrompt(ctx);
    if (!policy) return { systemPrompt: event.systemPrompt };
    return { systemPrompt: `${event.systemPrompt}\n\n${policy}` };
  });
}

export async function handleWorkerCommand(args: unknown, ctx: any): Promise<void> {
  const input = String(args ?? "").trim();
  const parts = input.split(/\s+/);
  const command = parts[0] || "status";
  const rest = parts.slice(1);

  if (command === "status") {
    ctx.ui.notify(formatWorkerState(readWorkerState(ctx)), "info");
    return;
  }

  if (command === "help") {
    ctx.ui.notify(workerHelp(), "info");
    return;
  }

  if (command === "ask") {
    ctx.ui.notify("Worker use is opt-in. Request a model with /pi-rogue-orchestration worker use <provider>/<model>.", "info");
    return;
  }

  if (command === "clear") {
    clearWorker(ctx);
    ctx.ui.notify("Worker selection cleared; frontier-only mode restored.", "info");
    return;
  }

  if (command === "use") {
    const model = rest.join(" ").trim();
    if (!isModelReference(model)) {
      ctx.ui.notify("Usage: /pi-rogue-orchestration worker use <provider>/<model>", "error");
      return;
    }
    const now = new Date().toISOString();
    const state = writeWorkerState(ctx, { enabled: true, model, approvedAt: now });
    ctx.ui.notify(`Worker request recorded: ${state.model} (session opt-in). Frontier remains controller.`, "info");
    return;
  }

  ctx.ui.notify(workerHelp(), "error");
}
