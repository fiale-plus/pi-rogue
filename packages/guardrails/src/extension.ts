import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanShellCommand, truncate } from "@fiale-plus/pi-core";
import { guardrailsConfigPath, loadGuardrailsConfig, saveGuardrailsConfig } from "./config.js";
import { llmReview } from "./llm-review.js";

function formatConfig(): string {
  const config = loadGuardrailsConfig();
  const fragments = config.extraDangerousFragments.length > 0
    ? config.extraDangerousFragments.map((fragment) => truncate(fragment, 40)).join(", ")
    : "none";

  return [
    `Mode: ${config.mode}`,
    `LLM review scaffold: ${config.llmReview.enabled ? "on" : "off"}`,
    `Extra fragments: ${fragments}`,
    `Config file: ${guardrailsConfigPath()}`,
  ].join("\n");
}

function saveMode(nextMode: "ask" | "block" | "allow"): string {
  const config = loadGuardrailsConfig();
  return saveGuardrailsConfig({ ...config, mode: nextMode }).mode;
}

function toggleLlm(enabled: boolean): boolean {
  const config = loadGuardrailsConfig();
  return saveGuardrailsConfig({ ...config, llmReview: { enabled } }).llmReview.enabled;
}

export function registerGuardrails(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String((event.input as { command?: unknown } | undefined)?.command ?? "").trim();
    if (!command) return;

    const config = loadGuardrailsConfig();
    const scan = scanShellCommand(command, config.extraDangerousFragments);
    if (scan.safe || config.mode === "allow") return;

    if (config.llmReview.enabled) {
      const result = await llmReview(command, scan, config.extraDangerousFragments);
      if (result.verdict === "allow") return;
      const reason = `Guardrails LLM review: ${result.reasoning}`;
      if (result.verdict === "block") {
        return { block: true, reason };
      }
    }

    const reason = `Guardrails blocked/flagged: ${scan.reason}`;
    if (config.mode === "block") {
      return { block: true, reason };
    }

    const allow = await ctx.ui.confirm(
      "Guardrails: risky command",
      `${reason}\n\nAllow this command?`,
    );

    if (!allow) {
      return { block: true, reason };
    }
  });

  pi.registerCommand("guardrails", {
    description: "Show or update the command-risk policy",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, value, ...rest] = input.split(/\s+/);
      const resolved = !input ? "show" : cmd || "show";

      if (resolved === "show") {
        ctx.ui.notify(formatConfig(), "info");
        return;
      }

      if (resolved === "mode") {
        if (value !== "ask" && value !== "block" && value !== "allow") {
          ctx.ui.notify("Usage: /guardrails mode ask|block|allow", "error");
          return;
        }

        const nextMode = saveMode(value);
        ctx.ui.notify(`Guardrails mode set to ${nextMode}.`, "info");
        return;
      }

      if (resolved === "llm") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("Usage: /guardrails llm on|off", "error");
          return;
        }

        const enabled = toggleLlm(value === "on");
        ctx.ui.notify(`LLM review scaffold ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }

      if (resolved === "add") {
        const fragment = [value, ...rest].join(" ").trim();
        if (!fragment) {
          ctx.ui.notify("Usage: /guardrails add <fragment>", "error");
          return;
        }

        const config = loadGuardrailsConfig();
        const next = saveGuardrailsConfig({
          ...config,
          extraDangerousFragments: [...config.extraDangerousFragments, fragment],
        });
        ctx.ui.notify(`Added fragment. Total: ${next.extraDangerousFragments.length}.`, "info");
        return;
      }

      if (resolved === "remove") {
        const fragment = [value, ...rest].join(" ").trim();
        if (!fragment) {
          ctx.ui.notify("Usage: /guardrails remove <fragment>", "error");
          return;
        }

        const config = loadGuardrailsConfig();
        const next = saveGuardrailsConfig({
          ...config,
          extraDangerousFragments: config.extraDangerousFragments.filter((entry) => entry !== fragment),
        });
        ctx.ui.notify(`Removed fragment. Total: ${next.extraDangerousFragments.length}.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /guardrails [show|mode|llm|add|remove]", "info");
    },
  });
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
  registerGuardrails(pi);
}
