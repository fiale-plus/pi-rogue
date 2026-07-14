import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { barePathLooksRequired, isNodeModulesPath } from "./artifact-reference-policy.js";

const EXTENSIONS = "md|json|txt|yaml|yml|toml|ts|js|tsx|jsx";
const HOME_ARTIFACT_RE = new RegExp(String.raw`(?<![A-Za-z0-9._/-])~/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(?:${EXTENSIONS})(?![A-Za-z0-9._/-])`, "g");
const ABSOLUTE_ARTIFACT_RE = new RegExp(String.raw`(?<![A-Za-z0-9._/~/-])/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(?:${EXTENSIONS})(?![A-Za-z0-9._/-])`, "g");
const QUOTED_RELATIVE_ARTIFACT_RE = new RegExp(String.raw`[\`'"]((?:\.{1,2}/)?[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\.(?:${EXTENSIONS}))[\`'"]`, "g");
const RELATIVE_PATH_ARTIFACT_RE = new RegExp(String.raw`(?<![A-Za-z0-9@._/-])((?:\.{1,2}/)?[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+\.(?:${EXTENSIONS}))(?![A-Za-z0-9._/-])`, "g");
const REVIEW_DOC_RE = /^(?:\.\/|\.\.\/)?(?:plan|progress)\.md$/i;

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

function isPreflightArtifactRef(ref: string, raw: string): boolean {
  if (!ref || /^[ab]\//.test(ref) || isNodeModulesPath(ref)) return false;
  if (ref.startsWith("/") || ref.startsWith("~/") || ref.startsWith("./") || ref.startsWith("../")) return true;
  // Ambiguous bare paths can be package-internal or incidental prose. Require
  // an explicit read instruction while preserving longstanding closeout docs.
  return REVIEW_DOC_RE.test(ref) || barePathLooksRequired(raw, ref);
}

function artifactAbsolutePath(cwd: string, ref: string): string {
  if (ref === "~") return homedir();
  if (ref.startsWith("~/")) return resolve(homedir(), ref.slice(2));
  return resolve(cwd, ref);
}

export function extractArtifactReferences(text: string): string[] {
  const raw = String(text ?? "");
  const refs = [
    ...collectMatches(HOME_ARTIFACT_RE, raw),
    ...collectMatches(ABSOLUTE_ARTIFACT_RE, raw),
    ...collectMatches(QUOTED_RELATIVE_ARTIFACT_RE, raw, 1),
    ...collectMatches(RELATIVE_PATH_ARTIFACT_RE, raw, 1),
  ];
  return [...new Set(refs.map(normalizeArtifactRef).filter((ref) => isPreflightArtifactRef(ref, raw)))];
}

export function findMissingArtifactReferences(cwd: string, ...texts: string[]): string[] {
  const refs = new Set<string>();
  for (const text of texts) {
    for (const ref of extractArtifactReferences(text)) refs.add(ref);
  }

  const missing: string[] = [];
  for (const ref of refs) {
    const absolute = artifactAbsolutePath(cwd, ref);
    if (!existsSync(absolute)) missing.push(ref);
  }
  return missing;
}
