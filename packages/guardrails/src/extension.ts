import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanShellCommand, truncate } from "@fiale-plus/pi-core";
import {
  guardrailsConfigPath,
  loadGuardrailsConfig,
  saveGuardrailsConfig,
} from "./config.js";
import { completeRestoreTransaction, clearExpiredRestoreTransactions, renderRestoreNote, restoreLedgerSummary, startRestoreTransaction } from "./restore-ledger.js";
import { llmReview } from "./llm-review.js";

const seenCommandAllowlist = new Map<string, number>();
const COMMAND_ALLOWLIST_SIZE_LIMIT = 64;
let sessionBypassEnabled = false;

function normalizeAllowedCommand(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .replace(/(["'])[^"']*\1/g, '"<str>"')
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ");
}

function clearRepeatedCommands(): void {
  seenCommandAllowlist.clear();
}

function markAllowed(command: string): void {
  const key = normalizeAllowedCommand(command);
  if (!key) return;

  if (!seenCommandAllowlist.has(key) && seenCommandAllowlist.size >= COMMAND_ALLOWLIST_SIZE_LIMIT) {
    const oldest = seenCommandAllowlist.keys().next().value;
    if (oldest) {
      seenCommandAllowlist.delete(oldest);
    }
  }

  seenCommandAllowlist.set(key, Date.now());
}

function isRepeatCommand(command: string): boolean {
  const key = normalizeAllowedCommand(command);
  if (!key) return false;

  return seenCommandAllowlist.has(key);
}

function formatConfig(): string {
  const config = loadGuardrailsConfig();
  const fragments = config.extraDangerousFragments.length > 0
    ? config.extraDangerousFragments.map((fragment) => truncate(fragment, 40)).join(", ")
    : "none";

  const modelLabel = config.llmReview.model === "local"
    ? "local tiny/binary"
    : config.llmReview.model || "auto (lightweight model)";

  const ledger = restoreLedgerSummary();

  return [
    `Mode: ${config.mode}`,
    `Warn-level prompts: ${config.askOnWarn ? "on" : "off"}`,
    `Session temporary allow: ${sessionBypassEnabled ? "on" : "off"}`,
    `LLM review scaffold: ${config.llmReview.enabled ? "on" : "off"}`,
    `LLM model: ${modelLabel}`,
    ledger,
    `Extra fragments: ${fragments}`,
    `Config file: ${guardrailsConfigPath()}`,
  ].filter(Boolean).join("\n");
}

function saveMode(nextMode: "off" | "ask" | "block" | "allow"): string {
  const config = loadGuardrailsConfig();
  return saveGuardrailsConfig({ ...config, mode: nextMode }).mode;
}

function saveAskOnWarn(enabled: boolean): boolean {
  const config = loadGuardrailsConfig();
  return saveGuardrailsConfig({ ...config, askOnWarn: enabled }).askOnWarn;
}

function toggleLlm(enabled: boolean): boolean {
  const config = loadGuardrailsConfig();
  return saveGuardrailsConfig({
    ...config,
    llmReview: {
      ...config.llmReview,
      enabled,
    },
  }).llmReview.enabled;
}


export function registerGuardrails(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String((event.input as { command?: unknown } | undefined)?.command ?? "").trim();
    if (!command) return;

    const config = loadGuardrailsConfig();
    clearExpiredRestoreTransactions();
    if (sessionBypassEnabled || config.mode === "off") return;

    const scan = scanShellCommand(command, config.extraDangerousFragments);
    if (scan.safe || config.mode === "allow") return;

    const restoreTx = await startRestoreTransaction(command, scan, ctx);
    if (restoreTx) {
      const short = renderRestoreNote(restoreTx);
      if (short) {
        ctx.ui.notify(short, short.startsWith("Restore window") ? "info" : "warning");
      }
    }

    const shouldAsk = config.mode === "ask" &&
      (scan.severity === "danger" || config.askOnWarn);

    if (config.mode === "block" || (!shouldAsk && config.mode === "ask")) {
      if (config.mode === "block") {
        if (config.llmReview.enabled) {
          const result = await llmReview(
            command,
            scan,
            config.extraDangerousFragments,
            ctx,
            config.llmReview.model,
          );
          if (result.verdict === "allow") {
            if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "executed");
            return;
          }
          const reason = `Guardrails LLM review: ${result.reasoning}`;
          if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "blocked");
          return { block: true, reason };
        }

        if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "blocked");
        return { block: true, reason: `Guardrails blocked/flagged: ${scan.reason}` };
      }

      if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "executed");
      if (!shouldAsk) {
        return;
      }
    }

    if (config.mode === "ask" && isRepeatCommand(command)) {
      if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "executed");
      return;
    }

    if (config.llmReview.enabled) {
      const result = await llmReview(
        command,
        scan,
        config.extraDangerousFragments,
        ctx,
        config.llmReview.model,
      );
      if (result.verdict === "allow") {
        if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "executed");
        return;
      }
      if (result.verdict === "block") {
        const reason = `Guardrails LLM review: ${result.reasoning}`;
        if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "blocked");
        return { block: true, reason };
      }
      if (!config.askOnWarn && scan.severity === "warn") {
        if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "executed");
        return;
      }
    }

    const reason = `Guardrails flagged: ${scan.reason}`;
    const allow = await ctx.ui.confirm(
      "Guardrails: risky command",
      `${reason}\n\nAllow this command?`,
    );

    if (!allow) {
      if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "aborted");
      return { block: true, reason };
    }

    if (restoreTx?.id) completeRestoreTransaction(restoreTx.id, "executed");
    markAllowed(command);
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
        if (value !== "off" && value !== "ask" && value !== "block" && value !== "allow") {
          ctx.ui.notify("Usage: /guardrails mode off|ask|block|allow", "error");
          return;
        }

        const nextMode = saveMode(value);
        ctx.ui.notify(`Guardrails mode set to ${nextMode}.`, "info");
        return;
      }

      if (resolved === "warn") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("Usage: /guardrails warn on|off", "error");
          return;
        }

        const enabled = saveAskOnWarn(value === "on");
        ctx.ui.notify(`Warn-level prompts are ${enabled ? "on" : "off"}.`, "info");
        return;
      }

      if (resolved === "session") {
        if (value === "on") {
          sessionBypassEnabled = true;
          ctx.ui.notify(
            "Session temporary guardrail bypass enabled (all flagged commands auto-allowed).",
            "info",
          );
          return;
        }

        if (value === "off") {
          sessionBypassEnabled = false;
          ctx.ui.notify("Session temporary guardrail bypass disabled.", "info");
          return;
        }

        if (value === "clear") {
          clearRepeatedCommands();
          ctx.ui.notify("Session command allowlist cleared.", "info");
          return;
        }

        if (value === "status") {
          ctx.ui.notify(formatConfig(), "info");
          return;
        }

        ctx.ui.notify("Usage: /guardrails session on|off|clear|status", "error");
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

      if (resolved === "llm-model") {
        if (!value) {
          ctx.ui.notify("Usage: /guardrails llm-model auto|local|provider/model", "error");
          return;
        }

        const config = loadGuardrailsConfig();
        if (value === "auto") {
          const next = saveGuardrailsConfig({
            ...config,
            llmReview: {
              ...config.llmReview,
              model: undefined,
            },
          });
          ctx.ui.notify(`LLM review model set to ${next.llmReview.model || "auto"}.`, "info");
          return;
        }

        if (["local", "tiny", "binary"].includes(value.toLowerCase())) {
          const next = saveGuardrailsConfig({
            ...config,
            llmReview: {
              ...config.llmReview,
              model: "local",
            },
          });
          ctx.ui.notify(`LLM review model set to ${next.llmReview.model}.`, "info");
          return;
        }

        if (!value.includes("/")) {
          ctx.ui.notify("Usage: /guardrails llm-model auto|local|provider/model", "error");
          return;
        }

        const next = saveGuardrailsConfig({
          ...config,
          llmReview: {
            ...config.llmReview,
            model: value,
          },
        });
        ctx.ui.notify(`LLM review model set to ${next.llmReview.model}.`, "info");
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

      ctx.ui.notify("Usage: /guardrails [show|mode|warn|session|llm|llm-model|add|remove]", "info");
    },
  });
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
  registerGuardrails(pi);
}
