import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendText, featureFile, readText, sessionFile, truncate, writeText } from "@fiale-plus/pi-core";

const FEATURE = "goal";
const HISTORY_FILE = featureFile(FEATURE, "history.jsonl");

function activeGoal(ctx: any): string {
  return readText(sessionFile(FEATURE, ctx, "current.md")).trim();
}

function setGoal(ctx: any, goal: string): void {
  const note = goal.trim();
  writeText(sessionFile(FEATURE, ctx, "current.md"), `${note}\n`);
  appendText(HISTORY_FILE, `${JSON.stringify({ at: new Date().toISOString(), goal: note })}\n`);
}

function clearGoal(ctx: any): void {
  writeText(sessionFile(FEATURE, ctx, "current.md"), "");
}

function goalBlock(goal: string): string {
  return [`## PiRogue Goal`, `Current goal: ${goal}`].join("\n");
}

function historyEntries(): Array<{ at: string; goal: string }> {
  const raw = readText(HISTORY_FILE).trim();
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-10)
    .map((line) => {
      try {
        return JSON.parse(line) as { at: string; goal: string };
      } catch {
        return { at: new Date().toISOString(), goal: line };
      }
    });
}

export function registerGoal(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const goal = activeGoal(ctx);
    if (!goal) {
      return { systemPrompt: event.systemPrompt };
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${goalBlock(goal)}` };
  });

  pi.registerCommand("goal", {
    description: "Set, show, clear, or list the current session goal",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, ...rest] = input.split(/\s+/);
      const known = new Set(["set", "show", "clear", "list"]);
      const resolved = !input ? "show" : known.has(cmd) ? cmd : "set";
      const text = resolved === "set" && known.has(cmd) ? rest.join(" ").trim() : input;

      if (resolved === "show") {
        const goal = activeGoal(ctx);
        ctx.ui.notify(goal ? `🎯 ${truncate(goal, 160)}` : "No active goal.", "info");
        return;
      }

      if (resolved === "clear") {
        const goal = activeGoal(ctx);
        clearGoal(ctx);
        ctx.ui.notify(goal ? "Goal cleared." : "No goal to clear.", "info");
        return;
      }

      if (resolved === "list") {
        const entries = historyEntries();
        if (entries.length === 0) {
          ctx.ui.notify("No goal history yet.", "info");
          return;
        }

        const text = entries
          .map((entry, index) => `${index + 1}. ${truncate(entry.goal, 120)} (${new Date(entry.at).toLocaleDateString()})`)
          .join("\n");
        ctx.ui.notify(text, "info");
        return;
      }

      if (!text) {
        ctx.ui.notify("Usage: /goal set <text>", "error");
        return;
      }

      setGoal(ctx, text);
      ctx.ui.notify(`🎯 Goal set: ${truncate(text, 160)}`, "info");
    },
  });
}

export default function goalExtension(pi: ExtensionAPI): void {
  registerGoal(pi);
}
