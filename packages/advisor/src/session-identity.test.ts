import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function ctx(path: string) {
  return { sessionManager: { getSessionFile: () => path } };
}

describe("advisor session identity", () => {
  it("isolates state paths for same-basename sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { advisorSessionStatePath } = await import("./extension.js");
    const first = advisorSessionStatePath(ctx("/tmp/repo-a/shared.jsonl"));
    const second = advisorSessionStatePath(ctx("/tmp/repo-b/shared.jsonl"));

    expect(first).not.toBe(second);
    mkdirSync(dirname(first), { recursive: true });
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(first, '{"lastTask":"first"}\n', "utf8");
    writeFileSync(second, '{"lastTask":"second"}\n', "utf8");
    expect(readFileSync(first, "utf8")).toContain("first");
    expect(readFileSync(second, "utf8")).toContain("second");
  });

  it("copies basename-only advisor state into v2 storage without deleting legacy data", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const legacy = join(home, ".pi", "agent", "pi-rogue", "advisor", "sessions", "shared", "state.json");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"lastTask":"legacy"}\n', "utf8");
    const { advisorSessionStatePath } = await import("./extension.js");

    const current = advisorSessionStatePath(ctx("/tmp/repo-a/shared.jsonl"));
    const unclaimed = advisorSessionStatePath(ctx("/tmp/repo-b/shared.jsonl"));

    expect(current).not.toBe(legacy);
    expect(readFileSync(current, "utf8")).toContain("legacy");
    expect(() => readFileSync(unclaimed, "utf8")).toThrow();
    expect(readFileSync(legacy, "utf8")).toContain("legacy");
  });
});
