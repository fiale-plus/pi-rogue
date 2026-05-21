import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendText, featureFile, readText, truncate, writeText } from "@fiale-plus/pi-core";

const FEATURE = "advisor";
const CURRENT_FILE = featureFile(FEATURE, "current.md");
const HISTORY_FILE = featureFile(FEATURE, "history.jsonl");

function currentAdvisor(): string {
  return readText(CURRENT_FILE).trim();
}

function recordAdvisor(note: string): void {
  const value = note.trim();
  writeText(CURRENT_FILE, `${value}\n`);
  appendText(HISTORY_FILE, `${JSON.stringify({ at: new Date().toISOString(), note: value })}\n`);
}

function clearAdvisor(): void {
  writeText(CURRENT_FILE, "");
}

function historyEntries(): Array<{ at: string; note: string }> {
  const raw = readText(HISTORY_FILE).trim();
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-10)
    .map((line) => {
      try {
        return JSON.parse(line) as { at: string; note: string };
      } catch {
        return { at: new Date().toISOString(), note: line };
      }
    });
}

function advisorBlock(note: string): string {
  return ["## Fiale Plus Advisor", note].join("\n");
}

export function registerAdvisor(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const note = currentAdvisor();
    if (!note) {
      return { systemPrompt: event.systemPrompt };
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${advisorBlock(note)}` };
  });

  pi.registerCommand("advisor", {
    description: "Set or inspect the current advisor note",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, ...rest] = input.split(/\s+/);
      const known = new Set(["set", "show", "clear", "list"]);
      const resolved = !input ? "show" : known.has(cmd) ? cmd : "set";
      const text = resolved === "set" && known.has(cmd) ? rest.join(" ").trim() : input;

      if (resolved === "show") {
        const note = currentAdvisor();
        ctx.ui.notify(note ? `🧭 ${truncate(note, 160)}` : "No advisor note set.", "info");
        return;
      }

      if (resolved === "clear") {
        const note = currentAdvisor();
        clearAdvisor();
        ctx.ui.notify(note ? "Advisor note cleared." : "No advisor note to clear.", "info");
        return;
      }

      if (resolved === "list") {
        const entries = historyEntries();
        if (entries.length === 0) {
          ctx.ui.notify("No advisor history yet.", "info");
          return;
        }

        const text = entries
          .map((entry, index) => `${index + 1}. ${truncate(entry.note, 120)} (${new Date(entry.at).toLocaleDateString()})`)
          .join("\n");
        ctx.ui.notify(text, "info");
        return;
      }

      if (!text) {
        ctx.ui.notify("Usage: /advisor set <text>", "error");
        return;
      }

      recordAdvisor(text);
      ctx.ui.notify(`🧭 Advisor set: ${truncate(text, 160)}`, "info");
    },
  });
}

export default function advisorExtension(pi: ExtensionAPI): void {
  registerAdvisor(pi);
}
