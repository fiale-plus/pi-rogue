type CompletionItem = { value: string; label: string; description?: string };

function item(value: string, description?: string): CompletionItem {
  return { value, label: value, ...(description ? { description } : {}) };
}

function complete(values: Array<[string, string?]>, prefix: string): CompletionItem[] | null {
  const q = prefix.trimStart().toLowerCase();
  const items = values.map(([value, description]) => item(value, description));
  const filtered = q
    ? items.filter((i) => i.value.startsWith(q))
    : items;
  return filtered.length > 0 ? filtered : null;
}

function completionsForPrefix(prefix: string, topLevel: Array<[string, string?]>, nested: Record<string, Array<[string, string?]>>): CompletionItem[] | null {
  const q = prefix.trimStart().toLowerCase();
  if (!q) return complete(topLevel, q);

  const [head, ...rest] = q.split(/\s+/);
  if (!head) return complete(topLevel, q);

  if (rest.length === 0) {
    const top = complete(topLevel, head);
    if (top) return top;
  }

  const next = nested[head];
  if (next) {
    return complete(next, rest.join(" "));
  }

  return complete(topLevel, q);
}

const advisorTopLevel: Array<[string, string?]> = [
  ["status", "show advisor status and configuration"],
  ["on", "enable auto mode"],
  ["off", "disable advisor"],
  ["mode", "set auto/manual/off"],
  ["review", "set light/strict/off"],
  ["model", "set or inspect model override"],
  ["checkins", "explain orchestration-managed check-ins"],
  ["board", "inspect or configure Advisor Board shadow/head-of-board modes"],
];

const advisorNested: Record<string, Array<[string, string?]>> = {
  mode: [["auto"], ["manual"], ["off"]],
  review: [["light"], ["strict"], ["off"]],
  model: [["auto"], ["openai-codex/gpt-5.5"], ["anthropic/claude-opus-4-6"]],
  board: [["status"], ["shadow"], ["off"], ["reset"], ["head"], ["specialist"]],
};

const piRogueTopLevel: Array<[string, string?]> = [
  ["status", "show aggregate Pi-Rogue setup and cockpit"],
  ["help", "show canonical command roots"],
  ["doctor", "show setup/diagnostic checklist"],
];

const piRogueNested: Record<string, Array<[string, string?]>> = {};

export function advisorArgumentCompletions(prefix: string): CompletionItem[] | null {
  return completionsForPrefix(prefix, advisorTopLevel, advisorNested);
}

export function piRogueArgumentCompletions(prefix: string): CompletionItem[] | null {
  return completionsForPrefix(prefix, piRogueTopLevel, piRogueNested);
}
