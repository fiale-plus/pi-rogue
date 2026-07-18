import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleResearchCommand, registerAutoresearch, registerAutoresearchLab } from "./autoresearch.js";
import { goalArgumentCompletions, loopArgumentCompletions, autoresearchArgumentCompletions } from "./completions.js";
import { formatResearchState, readResearchState } from "./autoresearch-state.js";
import { activeGoal, handleGoalCommand, registerGoal } from "./goal.js";
import { formatLoopState, handleLoopCommand, readLoopState, registerLoop } from "./loop.js";
import { registerNoveltyGuard } from "./novelty-guard.js";
import { advisorCheckinDemandStatus } from "./advisor-checkins.js";
import { formatWorkerState, handleWorkerCommand, readWorkerState, registerWorker, workerArgumentCompletions } from "./worker.js";

type CompletionItem = { value: string; label: string; description?: string };

function item(value: string, description?: string): CompletionItem {
  return { value, label: value, ...(description ? { description } : {}) };
}

function orchestrationCompletions(prefix: string): CompletionItem[] | null {
  const input = prefix.trimStart();
  const [cmd, ...rest] = input.split(/\s+/);
  const tail = rest.join(" ");
  if (!input || !input.includes(" ")) {
    const q = input.toLowerCase();
    const items = [
      item("status", "show goal/loop/research state"),
      item("help", "show orchestration command tree"),
      item("goal ", "show/set/clear/list current goal"),
      item("loop ", "show/set/clear loop cadence"),
      item("autoresearch ", "solo research loop"),
      item("lab ", "parallel research lab loop"),
      item("worker ", "opt-in execution worker selection"),
    ];
    const out = q ? items.filter((entry) => entry.value.toLowerCase().startsWith(q)) : items;
    return out.length ? out : null;
  }
  if (cmd === "goal") return goalArgumentCompletions(tail);
  if (cmd === "loop") return loopArgumentCompletions(tail);
  if (cmd === "autoresearch" || cmd === "lab") return autoresearchArgumentCompletions(tail);
  if (cmd === "worker") return workerArgumentCompletions(tail);
  return null;
}

function orchestrationStatus(ctx: any): string {
  const goal = activeGoal(ctx);
  let checkins = "off";
  try {
    const demand = advisorCheckinDemandStatus();
    const owners = demand.owners.slice(0, 3);
    const more = demand.owners.length - owners.length;
    checkins = demand.enabled ? `mid-hour — ${owners.join(", ")}${more > 0 ? ` (+${more} more)` : ""}` : "off";
  } catch {
    checkins = "unavailable (demand registry invalid)";
  }
  return [
    "Pi-Rogue orchestration:",
    `goal: ${goal || "none"}`,
    `loop: ${formatLoopState(readLoopState(ctx))}`,
    `research: ${formatResearchState(readResearchState(ctx))}`,
    formatWorkerState(readWorkerState(ctx)),
    `check-ins: ${checkins}`,
  ].join("\n");
}

function orchestrationHelp(): string {
  return [
    "pi-rogue-orchestration command tree:",
    "  /pi-rogue-orchestration status",
    "  /pi-rogue-orchestration goal [show|status|set <text>|clear|list]",
    "  /pi-rogue-orchestration loop [status|off|clear|stop|<interval> <instruction>]",
    "  /pi-rogue-orchestration autoresearch [status|clear|<instruction>]",
    "  /pi-rogue-orchestration lab [status|clear|<instruction>]",
    "  /pi-rogue-orchestration worker [ask|use <model-ref>|status|clear]",
    "Aliases (same behavior): /goal, /loop, /autoresearch",
  ].join("\n");
}

function registerAliasCommands(pi: ExtensionAPI): void {
  const p = pi as any;
  if (!p.__piRogueOrchestrationAliasRegistered) {
    p.__piRogueOrchestrationAliasRegistered = true;

    pi.registerCommand("goal", {
      description: "Orchestration goal management. Alias for /pi-rogue-orchestration goal.",
      getArgumentCompletions: goalArgumentCompletions,
      handler: (args, ctx) => handleGoalCommand(pi, args, ctx),
    });

    pi.registerCommand("loop", {
      description: "Orchestration loop management. Alias for /pi-rogue-orchestration loop.",
      getArgumentCompletions: loopArgumentCompletions,
      handler: (args, ctx) => handleLoopCommand(pi, args, ctx),
    });

    pi.registerCommand("autoresearch", {
      description: "Orchestration autoresearch. Alias for /pi-rogue-orchestration autoresearch.",
      getArgumentCompletions: autoresearchArgumentCompletions,
      handler: async (args, ctx) => {
        await handleResearchCommand(pi, "autoresearch", args, ctx);
      },
    });
  }
}

export function registerOrchestration(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueOrchestrationRegistered) return;
  p.__piRogueOrchestrationRegistered = true;

  registerNoveltyGuard(pi);
  registerGoal(pi);
  registerLoop(pi);
  registerAutoresearch(pi);
  registerAutoresearchLab(pi);
  registerWorker(pi);
  registerAliasCommands(pi);

  pi.registerCommand("pi-rogue-orchestration", {
    description: "Pi-Rogue orchestration. Usage: /pi-rogue-orchestration status|help|goal|loop|autoresearch|lab",
    getArgumentCompletions: orchestrationCompletions,
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmdRaw, ...rest] = input.split(/\s+/);
      const cmd = cmdRaw || "status";
      const tail = rest.join(" ");
      if (cmd === "status" || cmd === "show") {
        ctx.ui.notify(orchestrationStatus(ctx), "info");
        return;
      }
      if (cmd === "help") {
        ctx.ui.notify(orchestrationHelp(), "info");
        return;
      }
      if (cmd === "goal") {
        await handleGoalCommand(pi, tail, ctx);
        return;
      }
      if (cmd === "loop") {
        await handleLoopCommand(pi, tail, ctx);
        return;
      }
      if (cmd === "autoresearch") {
        await handleResearchCommand(pi, "autoresearch", tail, ctx);
        return;
      }
      if (cmd === "lab" || cmd === "autoresearch-lab") {
        await handleResearchCommand(pi, "autoresearch-lab", tail, ctx);
        return;
      }
      if (cmd === "worker") {
        await handleWorkerCommand(tail, ctx);
        return;
      }
      ctx.ui.notify("Usage: /pi-rogue-orchestration status|help|goal|loop|autoresearch|lab|worker", "error");
    },
  });
}

export { registerAutoresearch, registerAutoresearchLab, registerGoal, registerLoop };

export default function orchestrationExtension(pi: ExtensionAPI): void {
  registerOrchestration(pi);
}
