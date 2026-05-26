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
  ["status", "show status and configuration"],
  ["config", "show full config"],
  ["on", "enable auto mode"],
  ["off", "disable advisor"],
  ["mode", "set auto/manual/off"],
  ["review", "set light/strict/off"],
  ["checkins", "configure mid-hour check-ins"],
  ["checkin", "alias for checkins"],
  ["model", "set or inspect model override"],
];

const advisorNested: Record<string, Array<[string, string?]>> = {
  mode: [["auto"], ["manual"], ["off"]],
  review: [["light"], ["strict"], ["off"]],
  checkins: [["on"], ["off"], ["10"], ["15"], ["30"], ["60"]],
  checkin: [["on"], ["off"], ["10"], ["15"], ["30"], ["60"]],
  model: [["auto"], ["openai-codex/gpt-5.5"], ["anthropic/claude-opus-4-6"]],
};

const piRogueTopLevel: Array<[string, string?]> = [
  ["status", "show cockpit"],
  ["advisor", "advisor status and check-ins"],
  ["orchestration", "goal/loop/autoresearch shortcuts"],
  ["checkins", "advisor check-ins"],
  ["help", "show cockpit help"],
];

const piRogueNested: Record<string, Array<[string, string?]>> = {
  advisor: advisorTopLevel,
  orchestration: [
    ["goal", "goal commands"],
    ["loop", "loop commands"],
    ["autoresearch", "solo research flow"],
    ["autoresearch-lab", "parallel research flow"],
    ["status", "show all surfaces"],
  ],
  checkins: advisorNested.checkins,
  help: [["advisor"], ["orchestration"], ["checkins"], ["status"]],
};

export function advisorArgumentCompletions(prefix: string): CompletionItem[] | null {
  return completionsForPrefix(prefix, advisorTopLevel, advisorNested);
}

export function piRogueArgumentCompletions(prefix: string): CompletionItem[] | null {
  return completionsForPrefix(prefix, piRogueTopLevel, piRogueNested);
}
