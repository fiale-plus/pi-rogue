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

  for (let split = rest.length; split >= 0; split -= 1) {
    const key = [head, ...rest.slice(0, split)].join(" ");
    const next = nested[key];
    if (next) return complete(next, rest.slice(split).join(" "));
  }

  return complete(topLevel, q);
}

export const ADVISOR_CANONICAL_CONTROL_LEAVES = ["status", "model", "board"] as const;

const advisorTopLevel: Array<[string, string?]> = [
  ["status", "show explicit Advisor and Board status"],
  ["settings", "show explicit Advisor settings"],
  ["model", "set or clear an explicit advisor, specialist, or head model"],
  ["board", "ask the read-only Board specialists or head"],
];

const advisorNested: Record<string, Array<[string, string?]>> = {
  model: [["list", "inspect available role candidates"], ["advisor"], ["specialist"], ["head"], ["null"]],
  "model list": [["advisor"], ["specialist"], ["head"]],
  board: [["watch"], ["specialist"], ["head"]],
  "board watch": [["status"], ["off"], ["shadow"], ["intervene"]],
};

const piRogueTopLevel: Array<[string, string?]> = [
  ["status", "show aggregate Pi-Rogue setup and cockpit"],
  ["help", "show canonical command roots"],
  ["doctor", "show setup/diagnostic checklist"],
  ["closeout", "record and inspect explicit session evidence"],
];

const piRogueNested: Record<string, Array<[string, string?]>> = {
  closeout: [["start"], ["add-evidence"], ["record"], ["show"], ["export"]],
  "closeout record": [["success"], ["partial"], ["failed"], ["abandoned"]],
};

export function advisorArgumentCompletions(prefix: string): CompletionItem[] | null {
  return completionsForPrefix(prefix, advisorTopLevel, advisorNested);
}

export function piRogueArgumentCompletions(prefix: string): CompletionItem[] | null {
  return completionsForPrefix(prefix, piRogueTopLevel, piRogueNested);
}
