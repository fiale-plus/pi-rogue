type CompletionItem = { value: string; label: string; description?: string };

function item(value: string, description?: string): CompletionItem {
  return { value, label: value, ...(description ? { description } : {}) };
}

function complete(values: Array<[string, string?]>, prefix: string): CompletionItem[] | null {
  const q = prefix.trimStart().toLowerCase();
  const items = values.map(([value, description]) => item(value, description));
  const filtered = q ? items.filter((i) => i.value.startsWith(q)) : items;
  return filtered.length > 0 ? filtered : null;
}

export function goalArgumentCompletions(prefix: string): CompletionItem[] | null {
  return complete(
    [
      ["show", "show current goal"],
      ["status", "show current goal"],
      ["clear", "clear current goal"],
      ["list", "list recent goals"],
      ["set", "set a goal"],
    ],
    prefix,
  );
}

export function loopArgumentCompletions(prefix: string): CompletionItem[] | null {
  return complete(
    [
      ["status", "show current loop"],
      ["show", "show current loop"],
      ["off", "clear current loop"],
      ["clear", "clear current loop"],
      ["stop", "clear current loop"],
      ["1m", "minimum cadence"],
      ["5m", "default cadence"],
      ["1h", "slower cadence"],
    ],
    prefix,
  );
}

export function autoresearchArgumentCompletions(prefix: string): CompletionItem[] | null {
  return complete(
    [
      ["status", "show research status"],
      ["show", "show research status"],
      ["clear", "clear research state"],
      ["stop", "clear research state"],
    ],
    prefix,
  );
}
