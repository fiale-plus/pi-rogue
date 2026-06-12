import { createHash } from "node:crypto";

export function hashText(...parts: string[]): string {
  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}

export function normalizeText(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/\b\d+(?:\.\d)?\b/g, " n ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashMaybe(text: unknown): string | undefined {
  const normalized = normalizeText(text);
  return normalized ? hashText(normalized) : undefined;
}
