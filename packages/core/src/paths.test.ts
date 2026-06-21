import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionDir, sessionKey } from "./paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("sessionKey", () => {
  it("returns session for missing session file", () => {
    expect(sessionKey({})).toBe("session");
  });

  it("keeps the legacy basename for persisted lookups", () => {
    expect(sessionKey({ sessionManager: { getSessionFile: () => "/tmp/.weird.jsonl" } })).toBe(".weird");
    expect(sessionKey({ sessionManager: { getSessionFile: () => "/var/folders/pi-review-summary.json" } })).toBe("pi-review-summary");
    expect(sessionKey({ sessionManager: { getSessionFile: () => "/tmp/HELLO WORLD!.jsonl" } })).toBe("HELLO WORLD!");
    expect(sessionKey({ sessionManager: { getSessionFile: () => "/tmp/../odd/..json" } })).toBe(".");
  });
});

describe("sessionDir", () => {
  it("prefers an existing legacy directory for backward compatibility", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir: sessionDirFresh } = await import("./paths.js");
    const feature = "core-session-key-test";
    const legacyDir = join(home, ".pi", "agent", "fiale-plus", feature, ".weird");
    mkdirSync(legacyDir, { recursive: true });

    const resolved = sessionDirFresh(feature, { sessionManager: { getSessionFile: () => "/tmp/.weird.jsonl" } });
    expect(resolved).toBe(legacyDir);
  });

  it("keeps distinct session filenames on distinct storage paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir: sessionDirFresh } = await import("./paths.js");
    const feature = "core-session-key-test";
    const first = basename(sessionDirFresh(feature, { sessionManager: { getSessionFile: () => "/tmp/Foo.jsonl" } }));
    const second = basename(sessionDirFresh(feature, { sessionManager: { getSessionFile: () => "/tmp/foo.jsonl" } }));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^foo-[a-f0-9]{8}$/);
    expect(second).toMatch(/^foo-[a-f0-9]{8}$/);
  });

  it("skips legacy paths that collapse to the feature root", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { sessionDir: sessionDirFresh } = await import("./paths.js");
    const feature = "core-session-key-test";
    const resolved = sessionDirFresh(feature, { sessionManager: { getSessionFile: () => "/tmp/..json" } });

    expect(basename(resolved)).toMatch(/^session-[a-f0-9]{8}$/);
  });
});
