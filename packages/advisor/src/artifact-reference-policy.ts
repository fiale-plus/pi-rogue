const NODE_MODULES_PATH_RE = /(?:^|\/)node_modules(?:\/|$)/;
const IMPERATIVE_VERBS = "read|open|review|check|inspect|see|use|load";
const EXTENSIONS = "md|json|txt|yaml|yml|toml|ts|js|tsx|jsx";
const ARTIFACT_TOKEN_RE = new RegExp(
  String.raw`[\`'\"]?(?:(?:~|\.{1,2})?/)?(?:@?[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(?:${EXTENSIONS})[\`'\"]?`,
  "gi",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refPattern(ref: string): string {
  return String.raw`[\`'\"]?${escapeRegExp(ref)}[\`'\"]?`;
}

function imperativeListContainsRef(raw: string, ref: string): boolean {
  const command = new RegExp(String.raw`\b(?:${IMPERATIVE_VERBS})\b`, "gi");
  const target = new RegExp(`${refPattern(ref)}(?![A-Za-z0-9._/-])`, "i");
  let match: RegExpExecArray | null;
  while ((match = command.exec(raw)) !== null) {
    let clause = raw.slice(command.lastIndex, command.lastIndex + 500);
    const boundary = clause.search(/(?:[!?](?=\s)|\.(?=\s)|[;\n])/);
    if (boundary >= 0) clause = clause.slice(0, boundary);
    if (!target.test(clause)) continue;

    const residue = clause
      .replace(ARTIFACT_TOKEN_RE, " ")
      .replace(/\b(?:the|these|following|required|file|files|artifact|artifacts|path|paths|bundle|bundles|and|or|before|continuing|proceed|proceeding|review|first|then|next|please)\b/gi, " ")
      .replace(/[\s,:()[\]`'"-]+/g, "");
    if (!residue) return true;
  }
  return false;
}

function imperativeMultilineListContainsRef(raw: string, ref: string): boolean {
  const header = new RegExp(
    String.raw`\b(?:${IMPERATIVE_VERBS})\b\s+(?:(?:the|these|following|required)\s+){0,4}(?:files?|artifacts?|paths?|bundles?)\s*:\s*\n`,
    "gi",
  );
  const target = new RegExp(`${refPattern(ref)}(?![A-Za-z0-9._/-])`, "i");
  let match: RegExpExecArray | null;
  while ((match = header.exec(raw)) !== null) {
    const lines = raw.slice(header.lastIndex).split("\n");
    const list: string[] = [];
    for (const line of lines) {
      if (!/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) break;
      list.push(line);
    }
    if (target.test(list.join("\n"))) return true;
  }
  return false;
}

export function isNodeModulesPath(ref: string): boolean {
  return NODE_MODULES_PATH_RE.test(ref);
}

export function barePathLooksRequired(raw: string, ref: string): boolean {
  const quoted = refPattern(ref);
  const structuredRead = new RegExp(
    String.raw`\[\s*(?:read(?:\s+from)?|input|artifact|file|path|bundle)\s*:\s*${quoted}\s*\]`,
    "i",
  );
  const directImperative = new RegExp(
    String.raw`\b(?:${IMPERATIVE_VERBS})\s+(?:the\s+)?${quoted}(?![A-Za-z0-9._/-])`,
    "i",
  );
  const artifactLabel = new RegExp(
    String.raw`\b(?:artifact|file|path|bundle)\s*(?::\s+|at\s+|is\s+|=\s+)${quoted}(?![A-Za-z0-9._/-])`,
    "i",
  );
  return structuredRead.test(raw)
    || directImperative.test(raw)
    || artifactLabel.test(raw)
    || imperativeListContainsRef(raw, ref)
    || imperativeMultilineListContainsRef(raw, ref);
}
