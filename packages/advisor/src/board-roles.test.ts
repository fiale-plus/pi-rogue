import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInBoardRolesDir, loadBoardRoleBody, loadBoardRoleCatalog, parseBoardRoleMarkdown } from "./board-roles.js";

const validRole = `---
id: security
kind: specialist
version: 1
enabledByDefault: true
callableBy: [user, codriver]
costTier: cheap
allowedTools: [read, search, context_lookup]
outputSchema: boardFinding.v1
triggerHints: [auth, secrets, permissions]
maxTokens: 1200
---
# Security

Reviews secrets, auth, permission, and data-loss risks from compact Board evidence.
`;

describe("board role catalog", () => {
  it("loads built-in role summaries without bodies", () => {
    const catalog = loadBoardRoleCatalog(builtInBoardRolesDir());
    const ids = catalog.roles.map((role) => role.id);

    expect(catalog.diagnostics).toEqual([]);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(["navigator", "head-of-board", "architecture", "debugger", "reliability-perf", "reviewer", "security"]));
    expect(ids).not.toEqual(expect.arrayContaining(["stale-evidence-auditor", "test-reviewer"]));
    expect(catalog.roles.every((role) => !("body" in role))).toBe(true);
  });

  it("loads full role bodies only on invocation", () => {
    const catalog = loadBoardRoleCatalog(builtInBoardRolesDir());
    const summary = catalog.roles.find((role) => role.id === "reviewer");

    expect(summary).toBeTruthy();
    expect(summary?.summary).toContain("regressions");
    const loaded = loadBoardRoleBody(summary!, builtInBoardRolesDir());
    expect(loaded.diagnostic).toBeUndefined();
    expect(loaded.role?.body).toContain("# Reviewer");
  });

  it("validates strict frontmatter schema", () => {
    const parsed = parseBoardRoleMarkdown(validRole, "security.md");
    const crlf = parseBoardRoleMarkdown(validRole.replace(/\n/g, "\r\n"), "security-crlf.md");

    expect(parsed.diagnostic).toBeUndefined();
    expect(crlf.diagnostic).toBeUndefined();
    expect(parsed.role).toMatchObject({
      id: "security",
      kind: "specialist",
      allowedTools: ["read", "search", "context_lookup"],
      title: "Security",
    });
  });

  it("fails closed with diagnostics for invalid role files", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-roles-"));
    writeFileSync(join(dir, "bad.md"), validRole.replace("id: security", "id: Not Valid"));
    const catalog = loadBoardRoleCatalog(dir);

    expect(catalog.roles).toEqual([]);
    expect(catalog.diagnostics[0]).toMatchObject({ severity: "error" });
    expect(catalog.diagnostics[0]?.message).toContain("id must be kebab-case");
  });

  it("proves Markdown cannot grant mutating tools", () => {
    const parsed = parseBoardRoleMarkdown(validRole.replace("allowedTools: [read, search, context_lookup]", "allowedTools: [read, bash, edit, write]"), "mutating.md");

    expect(parsed.role).toBeUndefined();
    expect(parsed.diagnostic?.message).toContain("mutating tools are not allowed");
  });

  it("does not follow catalog symlink directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-roles-"));
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "security.md"), validRole);
    mkdirSync(join(dir, "catalog"));
    symlinkSync(join(dir, "outside"), join(dir, "catalog", "linked"), "dir");

    const catalog = loadBoardRoleCatalog(join(dir, "catalog"));
    expect(catalog.roles).toEqual([]);
    expect(catalog.diagnostics).toEqual([]);
  });

  it("rejects symlink paths when loading bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-roles-"));
    mkdirSync(join(dir, "roles"));
    writeFileSync(join(dir, "target.md"), validRole);
    symlinkSync(join(dir, "target.md"), join(dir, "roles", "linked.md"));
    const loaded = loadBoardRoleBody({
      id: "security",
      kind: "specialist",
      version: 1,
      enabledByDefault: true,
      callableBy: ["user"],
      costTier: "cheap",
      allowedTools: ["read"],
      outputSchema: "boardFinding.v1",
      triggerHints: [],
      maxTokens: 1200,
      title: "Security",
      summary: "summary",
      path: "linked.md",
    }, join(dir, "roles"));

    expect(loaded.role).toBeUndefined();
    expect(loaded.diagnostic?.message).toContain("symlink");
  });

  it("rejects path traversal when loading bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-roles-"));
    mkdirSync(join(dir, "roles"));
    writeFileSync(join(dir, "roles", "security.md"), validRole);
    writeFileSync(join(dir, "outside.md"), validRole);
    const catalog = loadBoardRoleCatalog(join(dir, "roles"));
    const escaped = { ...catalog.roles[0]!, path: "../outside.md" };

    const loaded = loadBoardRoleBody(escaped, join(dir, "roles"));
    expect(loaded.role).toBeUndefined();
    expect(loaded.diagnostic?.message).toContain("escapes catalog root");
  });
});
