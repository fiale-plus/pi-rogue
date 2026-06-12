import { DEFAULT_ROUTER_CONFIG, loadRouterConfig } from "./config.js";

type CompletionItem = { value: string; label: string; description?: string };

function item(value: string, description?: string): CompletionItem {
  return { value, label: value, ...(description ? { description } : {}) };
}

function filter(items: CompletionItem[], prefix: string): CompletionItem[] | null {
  const q = prefix.trimStart().toLowerCase();
  const out = q ? items.filter((entry) => entry.value.toLowerCase().startsWith(q)) : items;
  return out.length ? out : null;
}

export function routerArgumentCompletions(prefix: string, ctx?: any): CompletionItem[] | null {
  const trimmed = prefix.trimStart();
  const [cmd, rest = ""] = trimmed.split(/\s+/, 2);
  const top = [
    item("on", "enable observe-only router summaries"),
    item("off", "disable router summaries"),
    item("status", "show router state and active profile"),
    item("profile", "show or set active router profile"),
    item("profiles", "list router profiles"),
    item("models", "show active role to model mapping"),
    item("configure", "write default local config if missing"),
    item("cycle", "cycle to the next router profile"),
  ];
  if (!cmd || !trimmed.includes(" ")) return filter(top, trimmed);
  if (cmd === "profile") {
    const config = ctx ? loadRouterConfig(ctx) : DEFAULT_ROUTER_CONFIG;
    return filter(config.profileOrder.map((name) => item(`profile ${name}`, config.profiles[name]?.worker)), `profile ${rest}`);
  }
  return null;
}
