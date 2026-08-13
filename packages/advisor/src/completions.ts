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

export const ADVISOR_CANONICAL_CONTROL_LEAVES = ["status", "model", "board"] as const;

const advisorTopLevel: Array<[string, string?]> = [
  ["status", "show explicit Advisor and Board status"],
  ["model", "set the explicit advisor model"],
  ["board", "ask the read-only Board specialists or head"],
];

const advisorNested: Record<string, Array<[string, string?]>> = {
  model: [["<provider>/<model>"]],
  board: [["specialist"], ["head"]],
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
