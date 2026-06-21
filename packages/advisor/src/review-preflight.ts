import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REVIEW_ARTIFACT_RE = /(?:\b(?:plan|progress)\.md\b|\/(?:private\/)?tmp\/[^\s`'"<>]+\.(?:md|json|txt|yaml|yml|toml|ts|js|tsx|jsx))/g;

function normalizeArtifactRef(ref: string): string {
  return ref.trim().replace(/[),.;:]+$/g, "");
}

export function extractReviewArtifactHints(text: string): string[] {
  const matches = String(text ?? "").match(REVIEW_ARTIFACT_RE) ?? [];
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
