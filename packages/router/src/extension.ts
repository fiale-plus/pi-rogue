import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  activeProfile,
  cycleRouterProfile,
  ensureRouterConfig,
  formatProfile,
  loadRouterConfig,
  routerConfigPath,
  routerEventsPath,
  saveRouterConfig,
  setRouterMode,
  setRouterPrint,
  setRouterProfile,
  type RouterConfig,
} from "./config.js";
import { observeRouterTurn } from "./observe.js";
import { routerArgumentCompletions } from "./completions.js";

function statusText(ctx: any, config: RouterConfig): string {
  const profile = activeProfile(config);
  return [
    `router: ${config.enabled ? "on" : "off"}`,
    `model routing: ${config.mode === "auto_model" ? "auto_model (applies model switches only)" : "observe (recommendations only)"}`,
    `print: ${config.print}`,
    `profile: ${config.activeProfile}`,
    `worker: ${profile.worker}`,
    `smart: ${profile.smart}`,
    `teacher: ${profile.teacher}`,
    `reviewer: ${profile.reviewer}`,
    `config: ${routerConfigPath(ctx)}`,
    `ledger: ${routerEventsPath(ctx)}`,
  ].join("\n");
}

function notifyProfile(ctx: any, config: RouterConfig, prefix = "router profile"): void {
  const profile = activeProfile(config);
  ctx.ui.notify(`${prefix}: ${config.activeProfile}\nworker: ${profile.worker}\nsmart: ${profile.smart}\nteacher: ${profile.teacher}\nreviewer: ${profile.reviewer}`, "info");
}

function helpText(ctx: any, config: RouterConfig): string {
  return [
    "router command tree:",
    "  /router status                 show current router state",
    "  /router help                   show this help",
    "  /router on                     enable router using current explicit mode",
    "  /router off                    disable router",
    "  /router mode observe           recommendations only",
    "  /router mode auto_model        apply model switches only",
    "  /router profile <name>         choose active profile",
    "  /router print mismatch_only    notify only mismatches",
    "  /router print all              notify every router decision",
    "  /router print off              suppress observe notifications",
    "  /router models                 show active role → model mapping",
    "  /router profiles               list configured profiles",
    "  /router cycle                  cycle to next profile",
    "  /router configure              create/show config",
    "",
    "safety: observe is recommendations only; auto_model applies model switches only, never agent/subagent/tool routing.",
    "",
    statusText(ctx, config),
  ].join("\n");
}

function setEnabled(ctx: any, enabled: boolean): void {
  const config = ensureRouterConfig(ctx);
  const next = { ...config, enabled };
  saveRouterConfig(ctx, next);
  ctx.ui.notify(enabled ? `router enabled: ${next.mode === "auto_model" ? "auto_model applies model switches only" : "observe recommendations only"}` : "router disabled", "info");
}

export function registerRouter(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueRouterRegistered) return;
  p.__piRogueRouterRegistered = true;

  pi.registerCommand("router", {
    description: "Trajectory router. Usage: /router status|help|on|off|mode|profile|print|profiles|models|configure|cycle. Default observe-only; auto_model applies model switches only.",
    getArgumentCompletions: (prefix: string, ctx?: any) => routerArgumentCompletions(prefix, ctx),
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmdRaw, ...rest] = input.split(/\s+/);
      const cmd = cmdRaw || "status";

      if (cmd === "on") {
        setEnabled(ctx, true);
        return;
      }
      if (cmd === "off") {
        setEnabled(ctx, false);
        return;
      }
      if (cmd === "configure" || cmd === "config") {
        const config = ensureRouterConfig(ctx);
        ctx.ui.notify(["router config ready", "", "next: /router mode …, /router profile …, /router print …", "", statusText(ctx, config)].join("\n"), "info");
        return;
      }

      const config = ensureRouterConfig(ctx);
      if (cmd === "help") {
        ctx.ui.notify(helpText(ctx, config), "info");
        return;
      }
      if (cmd === "status" || cmd === "show") {
        ctx.ui.notify(statusText(ctx, config), "info");
        return;
      }
      if (cmd === "models") {
        notifyProfile(ctx, config, "router models");
        return;
      }
      if (cmd === "mode") {
        const mode = rest[0];
        if (!mode) {
          ctx.ui.notify(statusText(ctx, config), "info");
          return;
        }
        const next = setRouterMode(config, mode);
        if (!next) {
          ctx.ui.notify("unknown router mode: use observe or auto_model", "error");
          return;
        }
        saveRouterConfig(ctx, next);
        ctx.ui.notify(`router model routing mode set: ${next.mode === "auto_model" ? "auto_model (model switches only)" : "observe (recommendations only)"}`, "info");
        return;
      }
      if (cmd === "print") {
        const print = rest[0];
        if (!print) {
          ctx.ui.notify(statusText(ctx, config), "info");
          return;
        }
        const next = setRouterPrint(config, print);
        if (!next) {
          ctx.ui.notify("unknown router print mode: use mismatch_only, all, or off", "error");
          return;
        }
        saveRouterConfig(ctx, next);
        ctx.ui.notify(`router print mode set: ${next.print}`, "info");
        return;
      }
      if (cmd === "profiles") {
        ctx.ui.notify(config.profileOrder.map((name) => {
          const marker = name === config.activeProfile ? "*" : " ";
          const profile = config.profiles[name];
          return `${marker} ${formatProfile(name, profile)}`;
        }).join("\n"), "info");
        return;
      }
      if (cmd === "profile") {
        const name = rest[0];
        if (!name) {
          notifyProfile(ctx, config);
          return;
        }
        const next = setRouterProfile(config, name);
        if (!next) {
          ctx.ui.notify(`unknown router profile: ${name}`, "error");
          return;
        }
        saveRouterConfig(ctx, next);
        notifyProfile(ctx, next, "router profile set");
        return;
      }
      if (cmd === "cycle" || cmd === "next") {
        const next = cycleRouterProfile(config, 1);
        saveRouterConfig(ctx, next);
        notifyProfile(ctx, next, "router profile cycled");
        return;
      }

      ctx.ui.notify("Usage: /router status|help|on|off|mode [observe|auto_model]|profile [name]|print [mismatch_only|all|off]|profiles|models|configure|cycle", "error");
    },
  });

  // Ctrl-P is reserved by Pi's built-in model cycle action, so the
  // extension uses an unreserved chord and exposes `/router cycle` for
  // command-palette/typed rotation over the same profile set.
  pi.registerShortcut("ctrl+alt+p", {
    description: "Cycle router profile",
    handler: async (ctx: any) => {
      const config = ensureRouterConfig(ctx);
      const next = cycleRouterProfile(config, 1);
      saveRouterConfig(ctx, next);
      notifyProfile(ctx, next, "router profile cycled");
    },
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    try {
      await observeRouterTurn(ctx, pi);
    } catch (error) {
      ctx.ui?.notify?.(`router observe failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
}

export default function routerExtension(pi: ExtensionAPI): void {
  registerRouter(pi);
}
