import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionKey } from "./paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function oldCoreKey(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^\.+/, "").replace(/\.+$/, "") || "session";
  return `${slug}-${createHash("sha256").update(label).digest("hex").slice(0, 8)}`;
}

describe("sessionKey", () => {
  it("returns session when no session identity is available", () => {
    expect(sessionKey({})).toBe("session");
  });

  it("distinguishes absolute session paths with the same basename", () => {
    const first = sessionKey({ sessionManager: { getSessionFile: () => "/tmp/repo-a/shared.jsonl" } });
    const second = sessionKey({ sessionManager: { getSessionFile: () => "/tmp/repo-b/shared.jsonl" } });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v2-shared-[a-f0-9]{16}$/);
    expect(second).toMatch(/^v2-shared-[a-f0-9]{16}$/);
  });

  it("normalizes equivalent absolute session paths", () => {
    const first = sessionKey({ sessionManager: { getSessionFile: () => "/tmp/repo-a/../repo-a/shared.jsonl" } });
    const second = sessionKey({ sessionManager: { getSessionFile: () => "/tmp/repo-a/shared.jsonl" } });
    expect(first).toBe(second);
  });

  it("uses session id when no session file exists", () => {
    const first = sessionKey({ session: { id: "session-a" } });
    const second = sessionKey({ session: { id: "session-b" } });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^v2-session-a-[a-f0-9]{16}$/);
  });

  it("keeps identity stable when a session file appears beneath a symlinked parent", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-session-path-"));
    const realDir = join(root, "real");
    const linkedDir = join(root, "linked");
    mkdirSync(realDir);
    symlinkSync(realDir, linkedDir, "dir");
    const sessionPath = join(linkedDir, "session.jsonl");
    const ctx = { sessionManager: { getSessionFile: () => sessionPath } };

    const before = sessionKey(ctx);
    writeFileSync(join(realDir, "session.jsonl"), "", "utf8");
    const after = sessionKey(ctx);

    expect(after).toBe(before);
  });
});

describe("sessionDir", () => {
  it("copies a basename-only legacy directory into v2 storage", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir } = await import("./paths.js");
    const feature = "core-session-key-test";
    const legacyDir = join(home, ".pi", "agent", "fiale-plus", feature, ".weird");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "state.json"), "legacy", "utf8");

    const resolved = sessionDir(feature, { sessionManager: { getSessionFile: () => "/tmp/.weird.jsonl" } });

    expect(resolved).not.toBe(legacyDir);
    expect(basename(resolved)).toMatch(/^v2-weird-[a-f0-9]{16}$/);
    expect(readFileSync(join(resolved, "state.json"), "utf8")).toBe("legacy");
    expect(existsSync(join(legacyDir, "state.json"))).toBe(true);
  });

  it("copies the prior pi-core basename-hash directory into v2 storage", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir } = await import("./paths.js");
    const feature = "core-session-key-test";
    const priorDir = join(home, ".pi", "agent", "fiale-plus", feature, oldCoreKey("Shared"));
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "state.json"), "prior-core", "utf8");

    const resolved = sessionDir(feature, { sessionManager: { getSessionFile: () => "/tmp/Shared.jsonl" } });

    expect(readFileSync(join(resolved, "state.json"), "utf8")).toBe("prior-core");
    expect(existsSync(join(priorDir, "state.json"))).toBe(true);
  });

  it("isolates same-basename sessions after copying ambiguous legacy state", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir } = await import("./paths.js");
    const feature = "core-session-key-test";
    const legacyDir = join(home, ".pi", "agent", "fiale-plus", feature, "shared");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "goal.md"), "legacy", "utf8");

    const first = sessionDir(feature, { sessionManager: { getSessionFile: () => "/tmp/repo-a/shared.jsonl" } });
    const second = sessionDir(feature, { sessionManager: { getSessionFile: () => "/tmp/repo-b/shared.jsonl" } });
    writeFileSync(join(first, "goal.md"), "first", "utf8");

    expect(first).not.toBe(second);
    expect(readFileSync(join(first, "goal.md"), "utf8")).toBe("first");
    expect(existsSync(join(second, "goal.md"))).toBe(false);
  });

  it("does not re-import legacy state after v2 storage exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir } = await import("./paths.js");
    const feature = "core-session-key-test";
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/shared.jsonl" } };
    const legacyDir = join(home, ".pi", "agent", "fiale-plus", feature, "shared");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "state.json"), "legacy-1", "utf8");

    const current = sessionDir(feature, ctx);
    writeFileSync(join(current, "state.json"), "current", "utf8");
    writeFileSync(join(legacyDir, "state.json"), "legacy-2", "utf8");

    expect(sessionDir(feature, ctx)).toBe(current);
    expect(readFileSync(join(current, "state.json"), "utf8")).toBe("current");
  });

  it("rejects symlinked v2 storage and nested legacy symlinks", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir, sessionKey: sessionKeyFresh } = await import("./paths.js");
    const feature = "core-session-key-test";
    const root = join(home, ".pi", "agent", "fiale-plus", feature);
    const outside = mkdtempSync(join(tmpdir(), "pi-rogue-outside-"));
    mkdirSync(root, { recursive: true });
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/repo-a/shared.jsonl" } };
    symlinkSync(outside, join(root, sessionKeyFresh(ctx)), "dir");
    expect(() => sessionDir(feature, ctx)).toThrow(/Unsafe session storage path/);

    unlinkSync(join(root, sessionKeyFresh(ctx)));
    const legacy = join(root, "shared");
    mkdirSync(legacy, { recursive: true });
    symlinkSync(join(outside, "state.json"), join(legacy, "state.json"));
    expect(() => sessionDir(feature, ctx)).toThrow(/Unsafe session storage symlink/);
  });

  it("never collapses a legacy path to the feature root", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir } = await import("./paths.js");
    const feature = "core-session-key-test";
    const resolved = sessionDir(feature, { sessionManager: { getSessionFile: () => "/tmp/..json" } });

    expect(basename(resolved)).toMatch(/^v2-session-[a-f0-9]{16}$/);
    expect(resolved).not.toBe(join(home, ".pi", "agent", "fiale-plus", feature));
  });
});
