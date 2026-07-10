import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { activeGoal } from "./goal.js";
import { registerOrchestration } from "./extension.js";

interface CommandHandle {
  handler: (args: string, ctx: any) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => any;
  description?: string;
}

function fakeCtx(id = randomUUID()) {
  const notifications: string[] = [];
  return {
    notifications,
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => `/tmp/pi-rogue-orchestration-test-${id}.jsonl`,
    },
    ui: {
      setStatus: () => undefined,
      notify: (message: string) => notifications.push(message),
    },
  };
}

function registerAndCaptureCommands(): { commands: Map<string, CommandHandle>; pi: any } {
  const commands = new Map<string, CommandHandle>();
  const pi = {
    registerCommand: (name: string, command: CommandHandle) => {
      commands.set(name, command);
    },
    sendUserMessage: vi.fn(),
    on: () => undefined,
  };
  registerOrchestration(pi as any);
  return { commands, pi };
}

describe("orchestration command aliases", () => {
  it("registers short command aliases", () => {
    const { commands } = registerAndCaptureCommands();
    expect(commands.has("goal")).toBe(true);
    expect(commands.has("loop")).toBe(true);
    expect(commands.has("autoresearch")).toBe(true);
    expect(commands.has("pi-rogue-orchestration")).toBe(true);
  });

  it("routes /goal to orchestration goal handling", async () => {
    const { commands } = registerAndCaptureCommands();
    const ctx = fakeCtx();
    const goalCommand = commands.get("goal");
    expect(goalCommand).toBeTypeOf("object");
    await goalCommand!.handler("set keep aliases handy", ctx);
    expect(activeGoal(ctx)).toBe("keep aliases handy");
    await goalCommand!.handler("show", ctx);
    expect(ctx.notifications.at(-1)).toContain("A goal is already active: keep aliases handy");
    expect(ctx.notifications.at(-1)).toContain("/goal show");
    expect(ctx.notifications.at(-1)).toContain("/goal clear");
    expect(ctx.notifications.at(-1)).toContain("/goal set ...");
    await goalCommand!.handler("clear", ctx);
    expect(activeGoal(ctx)).toBe("");
  });

  it("routes goal status read-only through short and canonical commands", async () => {
    const { commands, pi } = registerAndCaptureCommands();
    const ctx = fakeCtx();
    const goalCommand = commands.get("goal");
    const orchestrationCommand = commands.get("pi-rogue-orchestration");

    await goalCommand!.handler("set keep status read-only", ctx);
    pi.sendUserMessage.mockClear();

    await goalCommand!.handler("status", ctx);
    expect(activeGoal(ctx)).toBe("keep status read-only");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await orchestrationCommand!.handler("goal status", ctx);
    expect(activeGoal(ctx)).toBe("keep status read-only");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await goalCommand!.handler("clear", ctx);
  });

  it("routes /loop to orchestration loop handling", async () => {
    const { commands } = registerAndCaptureCommands();
    const ctx = fakeCtx();
    const loopCommand = commands.get("loop");
    expect(loopCommand).toBeTypeOf("object");
    await loopCommand!.handler("status", ctx);
    expect(ctx.notifications.at(-1)).toContain("No active loop.");
  });

  it("routes /autoresearch to orchestration autoresearch handling", async () => {
    const { commands } = registerAndCaptureCommands();
    const ctx = fakeCtx();
    const autoresearchCommand = commands.get("autoresearch");
    expect(autoresearchCommand).toBeTypeOf("object");
    await autoresearchCommand!.handler("status", ctx);
    expect(ctx.notifications.at(-1)).toContain("🔎 Autoresearch is off.");
  });
});
