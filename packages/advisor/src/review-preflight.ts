import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSIONS = "md|json|txt|yaml|yml|toml|ts|js|tsx|jsx";
const ABSOLUTE_REVIEW_ARTIFACT_RE = new RegExp(`\\/(?:[^\\s\`'\"<>),;:]+\\/)*[^\\s\`'\"<>),;:]+\\.(?:${EXTENSIONS})`, "g");
const REVIEW_DOC_RE = new RegExp(`(?:^|[\\s\`'\"])((?:\\.{1,2}\\/)?(?:[A-Za-z0-9._-]+\\/)*(?:plan|progress)\\.md)(?=$|[\\s\`'\"),.;:])`, "g");

function normalizeArtifactRef(ref: string): string {
  return ref.trim().replace(/[),.;:]+$/g, "");
}

function collectMatches(regex: RegExp, text: string, group = 0): string[] {
  regex.lastIndex = 0;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (group === 0 && regex === ABSOLUTE_REVIEW_ARTIFACT_RE) {
      const previous = text[match.index - 1];
      if (previous === ":") continue;
    }
    matches.push(match[group] ?? match[0]);
  }
  return matches;
}

export function extractReviewArtifactHints(text: string): string[] {
  const raw = String(text ?? "");
  const matches = [
    ...collectMatches(REVIEW_DOC_RE, raw, 1),
    ...collectMatches(ABSOLUTE_REVIEW_ARTIFACT_RE, raw),
  ];
  return [...new Set(matches.map(normalizeArtifactRef).filter(Boolean))];
}

export function findMissingReviewArtifacts(cwd: string, ...texts: string[]): string[] {
  const hints = new Set<string>();
  for (const text of texts) {
    for (const hint of extractReviewArtifactHints(text)) hints.add(hint);
  }

  const missing: string[] = [];
  for (const hint of hints) {
    const absolute = resolve(cwd, hint);
    if (!existsSync(absolute)) missing.push(hint);
  }
  return missing;
}
