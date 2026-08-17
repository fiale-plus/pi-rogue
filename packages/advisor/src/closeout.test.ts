import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function context(path: string, cwd = "/tmp/repo") {
  return { cwd, sessionManager: { getSessionFile: () => path } };
}

describe("session closeout ledger", () => {
  it("persists independently per session and records explicit outcomes/evidence", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-closeout-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const closeout = await import("./closeout.js");
    const first = context("/tmp/repo-a/session.jsonl");
    const second = context("/tmp/repo-b/session.jsonl");

    closeout.startCloseout(first, "Ship the release safely");
    closeout.addCloseoutEvidence(first, "ctx://validation-1");
    closeout.addCloseoutEvidence(first, "npm test passed");
    closeout.recordCloseoutStatus(first, "success");

    expect(closeout.loadCloseout(first)?.status).toBe("success");
    expect(closeout.loadCloseout(first)?.evidence.map((item) => item.kind)).toEqual(["handle", "note"]);
    expect(closeout.loadCloseout(second)).toBeUndefined();

    const exported = closeout.exportCloseout(first);
    expect(exported.path).toBeTruthy();
    expect(readFileSync(exported.path!, "utf8")).toContain("Ship the release safely");
  });

  it("refreshes bounded facts from advisor state without copying raw payloads", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-closeout-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const closeout = await import("./closeout.js");
    const current = context("/tmp/repo/session.jsonl");
    closeout.startCloseout(current, "Investigate the failure");

    const updated = closeout.syncCloseoutFacts(current, {
      turns: 4,
      files: ["src/fixed.ts"],
      errors: ["permission denied"],
      advisorCalls: 1,
      specialistDispatch: { calls: 2 },
      headOfBoard: { calls: 1 },
      evidenceLedger: [{ command: "npm test", result: "pass", exitCode: 0, timestamp: "2026-01-01T00:00:00Z" }],
      rawTranscript: "SECRET transcript must not be copied",
    });

    expect(updated?.facts).toMatchObject({ turns: 4, changedFiles: ["src/fixed.ts"], advisorCalls: 1, specialistCalls: 2, headCalls: 1 });
    expect(updated?.facts.validations[0]).toMatchObject({ command: "npm test", result: "pass", exitCode: 0 });
    expect(JSON.stringify(updated)).not.toContain("SECRET transcript");
  });

  it("normalizes malformed records and bounds display output", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-closeout-home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const closeout = await import("./closeout.js");
    const current = context("/tmp/repo/session.jsonl");
    const path = closeout.closeoutFilePath(current);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      session: { key: "wrong-session" },
      status: "not-a-status",
      summary: "token=sk-12345678901234567890",
      evidence: [{ reference: "ctx://one" }, null, { reference: "" }],
      facts: { turns: "bad", changedFiles: "bad", validations: "bad" },
    }), "utf8");
    expect(closeout.loadCloseout(current)).toBeUndefined();

    writeFileSync(path, JSON.stringify({
      session: { key: closeout.normalizeCloseout({ session: { key: "wrong-session" } })?.session.key ?? "" },
      status: "not-a-status",
      summary: "token=sk-12345678901234567890",
      evidence: [{ reference: "ctx://one" }, null, { reference: "" }],
      facts: { turns: "bad", changedFiles: "bad", validations: "bad" },
    }), "utf8");
    const record = closeout.normalizeCloseout(JSON.parse(readFileSync(path, "utf8")));
    expect(record?.status).toBe("open");
    expect(record?.evidence).toHaveLength(1);
    expect(record?.facts.turns).toBe(0);
    expect(closeout.closeoutText(record)).toContain("Status: **open**");
    expect(closeout.closeoutText(record)).toContain("token=[REDACTED]");
    expect(closeout.closeoutText(record)).not.toContain("sk-12345678901234567890");
  });
});
