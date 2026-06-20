import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSIONS = "md|json|txt|yaml|yml|toml|ts|js|tsx|jsx";
const ABSOLUTE_ARTIFACT_RE = new RegExp(`(?<![A-Za-z0-9._/-])\\/(?:[A-Za-z0-9._-]+\\/)*[A-Za-z0-9._-]+\\.(?:${EXTENSIONS})(?![A-Za-z0-9._/-])`, "g");
const QUOTED_RELATIVE_ARTIFACT_RE = new RegExp(`[\`'\"]((?:\\.{1,2}\\/)?[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*\\.(?:${EXTENSIONS}))[\`'\"]`, "g");
const RELATIVE_PATH_ARTIFACT_RE = new RegExp(`(?<![A-Za-z0-9._/-])((?:\\.{1,2}\\/)?[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)+\\.(?:${EXTENSIONS}))(?![A-Za-z0-9._/-])`, "g");

function normalizeArtifactRef(ref: string): string {
  return ref.trim().replace(/[),.;:]+$/g, "");
}

function collectMatches(regex: RegExp, text: string, group = 0): string[] {
  regex.lastIndex = 0;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[group] ?? match[0]);
  }
  return matches;
}

export function extractArtifactReferences(text: string): string[] {
  const raw = String(text ?? "");
  const refs = [
    ...collectMatches(ABSOLUTE_ARTIFACT_RE, raw),
    ...collectMatches(QUOTED_RELATIVE_ARTIFACT_RE, raw, 1),
    ...collectMatches(RELATIVE_PATH_ARTIFACT_RE, raw, 1),
  ];
  return [...new Set(refs.map(normalizeArtifactRef).filter((ref) => Boolean(ref) && !/^[ab]\//.test(ref)))];
}

export function findMissingArtifactReferences(cwd: string, ...texts: string[]): string[] {
  const refs = new Set<string>();
  for (const text of texts) {
    for (const ref of extractArtifactReferences(text)) refs.add(ref);
  }

  const missing: string[] = [];
  for (const ref of refs) {
    const absolute = resolve(cwd, ref);
    if (!existsSync(absolute)) missing.push(ref);
  }
  return missing;
}
