import { DEFAULT_ROUTER_CONFIG, formatProfile, loadRouterConfig } from "./config.js";

type CompletionItem = { value: string; label: string; description?: string };

function item(value: string, description?: string, label = value.trimEnd()): CompletionItem {
  return { value, label, ...(description ? { description } : {}) };
}

function filter(items: CompletionItem[], prefix: string): CompletionItem[] | null {
  const q = prefix.trimStart().toLowerCase();
  const out = q ? items.filter((entry) => entry.value.toLowerCase().startsWith(q) || entry.label.toLowerCase().startsWith(q)) : items;
  return out.length ? out : null;
}

function topLevelItems(): CompletionItem[] {
  return [
    item("status", "show current router state"),
    item("help", "show command tree and safety notes"),
    item("on", "enable router using the current explicit mode"),
    item("off", "disable router"),
    item("mode ", "choose observe or auto_model", "mode …"),
    item("profile ", "choose active router profile", "profile …"),
    item("print ", "choose router notification verbosity", "print …"),
    item("models", "show active role → model mapping"),
    item("profiles", "list all configured profiles"),
    item("cycle", "cycle to the next router profile"),
    item("configure", "create/show config and suggested next commands"),
  ];
}

export function routerArgumentCompletions(prefix: string, ctx?: any): CompletionItem[] | null {
  const trimmed = prefix.trimStart();
  const [cmd, rest = ""] = trimmed.split(/\s+/, 2);
  if (!cmd || !trimmed.includes(" ")) return filter(topLevelItems(), trimmed);

  if (cmd === "profile") {
    const config = ctx ? loadRouterConfig(ctx) : DEFAULT_ROUTER_CONFIG;
    return filter(config.profileOrder.map((name) => {
      const marker = name === config.activeProfile ? "active" : "profile";
      return item(`profile ${name}`, `${marker}: ${formatProfile(name, config.profiles[name])}`, name);
    }), `profile ${rest}`);
  }
  if (cmd === "mode") {
    return filter([
      item("mode observe", "recommendations only", "observe"),
      item("mode auto_model", "apply model switches only", "auto_model"),
    ], `mode ${rest}`);
  }
  if (cmd === "print") {
    return filter([
      item("print mismatch_only", "notify only route/model mismatches", "mismatch_only"),
      item("print all", "notify every router decision", "all"),
      item("print off", "suppress observe notifications", "off"),
    ], `print ${rest}`);
  }
  return null;
}
