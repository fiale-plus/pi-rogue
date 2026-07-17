import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatWorkerState, handleWorkerCommand, readWorkerState, registerWorker, workerSystemPrompt } from "./worker.js";

function fakeCtx() {
  const notifications: string[] = [];
  const sessionFile = `/tmp/pi-rogue-worker-test-${randomUUID()}.jsonl`;
  return {
    notifications,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined },
  };
}

describe("execution worker policy", () => {
  it("starts frontier-only and opts into a user-selected model", async () => {
    const ctx = fakeCtx();
    expect(formatWorkerState(readWorkerState(ctx))).toContain("frontier-only");
    expect(workerSystemPrompt(ctx)).toBeUndefined();

    await handleWorkerCommand("use local/qwen3.6-35b-a3b-128k", ctx);

    expect(readWorkerState(ctx)).toMatchObject({ enabled: true, model: "local/qwen3.6-35b-a3b-128k", scope: "session" });
    expect(workerSystemPrompt(ctx)).toContain("frontier controller");
    expect(ctx.notifications.at(-1)).toContain("session opt-in");
  });

  it("rejects an invalid model reference without enabling a worker", async () => {
    const ctx = fakeCtx();
    await handleWorkerCommand("use qwen", ctx);
    expect(readWorkerState(ctx).enabled).toBe(false);
    expect(ctx.notifications.at(-1)).toContain("provider>/<model>");
  });

  it("clears the worker selection", async () => {
    const ctx = fakeCtx();
    await handleWorkerCommand("use hosted/fast", ctx);
    await handleWorkerCommand("clear", ctx);
    expect(readWorkerState(ctx).enabled).toBe(false);
    expect(workerSystemPrompt(ctx)).toBeUndefined();
  });

  it("registers only the policy hook and does not add an implicit command", () => {
    const handlers = new Map<string, Function>();
    const commands: string[] = [];
    registerWorker({
      on: (event: string, handler: Function) => handlers.set(event, handler),
      registerCommand: (name: string) => commands.push(name),
    } as any);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(commands).toEqual([]);
  });
});
