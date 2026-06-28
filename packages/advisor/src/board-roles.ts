import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type BoardRoleKind = "navigator" | "head-of-board" | "specialist";
export type BoardRoleCaller = "user" | "codriver" | "navigator" | "head-of-board";
export type BoardRoleCostTier = "free" | "cheap" | "standard" | "expensive";
export type BoardRoleTool = "read" | "search" | "context_lookup";

export interface BoardRoleFrontmatter {
  id: string;
  kind: BoardRoleKind;
  version: number;
  enabledByDefault: boolean;
  callableBy: BoardRoleCaller[];
  costTier: BoardRoleCostTier;
  allowedTools: BoardRoleTool[];
  outputSchema: string;
  triggerHints: string[];
  maxTokens: number;
}

export interface BoardRoleSummary extends BoardRoleFrontmatter {
  path: string;
  title: string;
  summary: string;
}

export interface BoardRoleBody extends BoardRoleSummary {
  body: string;
}

export interface BoardRoleDiagnostic {
  file: string;
  severity: "error";
  message: string;
}

export interface BoardRoleCatalog {
  roles: BoardRoleSummary[];
  diagnostics: BoardRoleDiagnostic[];
}

const ROLE_KINDS = new Set<BoardRoleKind>(["navigator", "head-of-board", "specialist"]);
const CALLERS = new Set<BoardRoleCaller>(["user", "codriver", "navigator", "head-of-board"]);
const COST_TIERS = new Set<BoardRoleCostTier>(["free", "cheap", "standard", "expensive"]);
const READ_ONLY_TOOLS = new Set<BoardRoleTool>(["read", "search", "context_lookup"]);
const MUTATING_TOOLS = new Set(["bash", "edit", "write", "apply_patch", "shell"]);
const REQUIRED_KEYS = ["id", "kind", "version", "enabledByDefault", "callableBy", "costTier", "allowedTools", "outputSchema", "triggerHints", "maxTokens"];

export function builtInBoardRolesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../board");
}

function diagnostic(file: string, message: string): BoardRoleDiagnostic {
  return { file, severity: "error", message };
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  return value;
}

function parseStrictFrontmatter(source: string, file: string): { data?: Record<string, unknown>; body?: string; diagnostic?: BoardRoleDiagnostic } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { diagnostic: diagnostic(file, "missing frontmatter fence") };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { diagnostic: diagnostic(file, "missing closing frontmatter fence") };
  const raw = normalized.slice(4, end).trim();
  const afterFence = normalized.slice(end + "\n---".length);
  const body = afterFence.replace(/^\r?\n/, "").trim();
  const data: Record<string, unknown> = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed);
    if (!match) return { diagnostic: diagnostic(file, `unsupported frontmatter syntax on line ${index + 1}`) };
    const [, key, value] = match;
    if (Object.prototype.hasOwnProperty.call(data, key)) return { diagnostic: diagnostic(file, `duplicate frontmatter key '${key}'`) };
    data[key] = parseScalar(value);
  }
  return { data, body };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function validateFrontmatter(data: Record<string, unknown>, file: string): { frontmatter?: BoardRoleFrontmatter; diagnostic?: BoardRoleDiagnostic } {
  const extra = Object.keys(data).filter((key) => !REQUIRED_KEYS.includes(key));
  if (extra.length > 0) return { diagnostic: diagnostic(file, `unknown frontmatter key(s): ${extra.join(", ")}`) };
  const missing = REQUIRED_KEYS.filter((key) => data[key] === undefined);
  if (missing.length > 0) return { diagnostic: diagnostic(file, `missing required key(s): ${missing.join(", ")}`) };

  const id = data.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) return { diagnostic: diagnostic(file, "id must be kebab-case") };
  const kind = data.kind;
  if (typeof kind !== "string" || !ROLE_KINDS.has(kind as BoardRoleKind)) return { diagnostic: diagnostic(file, "kind is invalid") };
  const version = data.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { diagnostic: diagnostic(file, "version must be a positive integer") };
  const enabledByDefault = data.enabledByDefault;
  if (typeof enabledByDefault !== "boolean") return { diagnostic: diagnostic(file, "enabledByDefault must be boolean") };
  const callableBy = stringArray(data.callableBy);
  if (!callableBy || callableBy.length === 0 || callableBy.some((item) => !CALLERS.has(item as BoardRoleCaller))) return { diagnostic: diagnostic(file, "callableBy contains invalid caller(s)") };
  const costTier = data.costTier;
  if (typeof costTier !== "string" || !COST_TIERS.has(costTier as BoardRoleCostTier)) return { diagnostic: diagnostic(file, "costTier is invalid") };
  const allowedTools = stringArray(data.allowedTools);
  if (!allowedTools) return { diagnostic: diagnostic(file, "allowedTools must be an array") };
  const mutating = allowedTools.filter((tool) => MUTATING_TOOLS.has(tool));
  if (mutating.length > 0) return { diagnostic: diagnostic(file, `mutating tools are not allowed in Markdown roles: ${mutating.join(", ")}`) };
  if (allowedTools.some((tool) => !READ_ONLY_TOOLS.has(tool as BoardRoleTool))) return { diagnostic: diagnostic(file, "allowedTools contains tool(s) outside the read-only allowlist") };
  const outputSchema = data.outputSchema;
  if (typeof outputSchema !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(outputSchema)) return { diagnostic: diagnostic(file, "outputSchema is invalid") };
  const triggerHints = stringArray(data.triggerHints);
  if (!triggerHints || triggerHints.some((item) => !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(item))) return { diagnostic: diagnostic(file, "triggerHints must be lowercase hint strings") };
  const maxTokens = data.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 100 || maxTokens > 4000) return { diagnostic: diagnostic(file, "maxTokens must be between 100 and 4000") };

  return {
    frontmatter: {
      id,
      kind: kind as BoardRoleKind,
      version,
      enabledByDefault,
      callableBy: callableBy as BoardRoleCaller[],
      costTier: costTier as BoardRoleCostTier,
      allowedTools: allowedTools as BoardRoleTool[],
      outputSchema,
      triggerHints,
      maxTokens,
    },
  };
}

function titleAndSummary(body: string): { title: string; summary: string } {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => line.startsWith("# "));
  const paragraph = lines.find((line) => !line.startsWith("#") && !line.startsWith("- ")) ?? "";
  return { title: heading ? heading.slice(2).trim() : "Untitled Board Role", summary: paragraph.slice(0, 300) };
}

export function parseBoardRoleMarkdown(source: string, file = "<memory>"): { role?: BoardRoleBody; diagnostic?: BoardRoleDiagnostic } {
  const parsed = parseStrictFrontmatter(source, file);
  if (parsed.diagnostic) return { diagnostic: parsed.diagnostic };
  const validated = validateFrontmatter(parsed.data ?? {}, file);
  if (validated.diagnostic) return { diagnostic: validated.diagnostic };
  const body = parsed.body ?? "";
  if (!body.trim()) return { diagnostic: diagnostic(file, "role body is empty") };
  const { title, summary } = titleAndSummary(body);
  return { role: { ...validated.frontmatter!, path: file, title, summary, body } };
}

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) files.push(...markdownFiles(full));
    else if (st.isFile() && name.endsWith(".md")) files.push(full);
  }
  return files;
}

function roleSummary(role: BoardRoleBody): BoardRoleSummary {
  const { body: _body, ...summary } = role;
  return summary;
}

export function loadBoardRoleCatalog(rootDir = builtInBoardRolesDir()): BoardRoleCatalog {
  const root = resolve(rootDir);
  const roles: BoardRoleSummary[] = [];
  const diagnostics: BoardRoleDiagnostic[] = [];
  const ids = new Set<string>();
  for (const file of markdownFiles(root)) {
    const rel = relative(root, file) || basename(file);
    const parsed = parseBoardRoleMarkdown(readFileSync(file, "utf8"), rel);
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }
    const role = parsed.role!;
    if (ids.has(role.id)) {
      diagnostics.push(diagnostic(rel, `duplicate role id '${role.id}'`));
      continue;
    }
    ids.add(role.id);
    roles.push(roleSummary(role));
  }
  return { roles: roles.sort((a, b) => a.id.localeCompare(b.id)), diagnostics };
}

export function loadBoardRoleBody(summary: BoardRoleSummary, rootDir = builtInBoardRolesDir()): { role?: BoardRoleBody; diagnostic?: BoardRoleDiagnostic } {
  const root = resolve(rootDir);
  const full = resolve(root, summary.path);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) return { diagnostic: diagnostic(summary.path, "role path escapes catalog root") };
  if (lstatSync(full).isSymbolicLink()) return { diagnostic: diagnostic(summary.path, "role path is a symlink") };
  const realRoot = realpathSync(root);
  const realFull = realpathSync(full);
  const realRel = relative(realRoot, realFull);
  if (realRel.startsWith("..") || isAbsolute(realRel)) return { diagnostic: diagnostic(summary.path, "role path escapes catalog root") };
  const parsed = parseBoardRoleMarkdown(readFileSync(full, "utf8"), summary.path);
  if (parsed.diagnostic) return parsed;
  if (parsed.role!.id !== summary.id) return { diagnostic: diagnostic(summary.path, "role id changed since summary load") };
  return parsed;
}
