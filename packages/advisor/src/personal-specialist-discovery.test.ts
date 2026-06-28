import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPersonalSpecialists, formatPersonalSpecialistDiscoverySnapshot, loadPersonalSpecialistDiscoverySnapshot, queuePersonalSpecialistDiscoveryRefresh } from "./personal-specialist-discovery.js";

function writeSession(file: string, cwd: string, id: string, userTexts: string[]): void {
  const rows = [
    { type: "session", id, cwd },
    ...userTexts.map((text, index) => ({
      type: "message",
      id: `${id}-msg-${index}`,
      message: { role: "user", content: [{ type: "text", text }] },
    })),
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

describe("personal specialist discovery", () => {
  it("is disabled without explicit consent", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-specialist-discovery-"));
    try {
      const result = discoverPersonalSpecialists({ sessionRoot: root, cwdContains: "/Users/pavel/repos/fiale-plus/worktrees/pi-rogue-issue225-personal-specialists" });

      expect(result.enabled).toBe(false);
      expect(result.skipped).toBe("consent_required");
      expect(result.candidates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers broad specialist candidates from local session metadata and writes disabled markdown previews", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-specialist-discovery-"));
    const output = join(root, "generated");
    const cwd = "/Users/pavel/repos/fiale-plus/worktrees/pi-rogue-issue225-personal-specialists";
    writeSession(join(root, "s1.jsonl"), cwd, "s1", [
      "fix the tests and validation around the refactor",
      "check auth token and permission handling",
      "the timeout loop keeps failing",
    ]);
    writeSession(join(root, "s2.jsonl"), cwd, "s2", [
      "review the API boundary and design",
      "performance budget and latency look high",
    ]);

    try {
      const result = discoverPersonalSpecialists({
        sessionRoot: root,
        cwdContains: cwd,
        allowPastSessionDiscovery: true,
        outputDir: output,
      });

      expect(result.enabled).toBe(true);
      expect(result.scannedSessions).toBe(2);
      expect(result.candidates.map((item) => item.roleId)).toEqual(expect.arrayContaining(["personal-reviewer", "personal-security", "personal-debugger", "personal-architecture", "personal-reliability-perf"]));
      expect(result.candidates.every((item) => item.sourceRoleId && !item.roleId.startsWith(item.sourceRoleId))).toBe(true);
      expect(result.candidates.every((item) => item.markdownPath?.startsWith(output))).toBe(true);
      expect(readFileSync(join(output, "personal-reviewer.md"), "utf8")).toContain("enabledByDefault: false");
      expect(readFileSync(join(output, "personal-security.md"), "utf8")).toContain("Source sessions: s1");
      expect(readFileSync(join(output, "personal-debugger.md"), "utf8")).toContain("Matched signals:");
      expect(readFileSync(join(output, "personal-architecture.md"), "utf8")).toContain("Generated from past session metadata");
      expect(readFileSync(join(output, "personal-reliability-perf.md"), "utf8")).toContain("disabled-by-default");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the session cap after cwd filtering so unrelated projects do not consume the budget", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-specialist-discovery-limit-"));
    const output = join(root, "generated");
    const matchingCwd = "/Users/pavel/repos/fiale-plus/worktrees/pi-rogue-issue225-personal-specialists";
    writeSession(join(root, "a.jsonl"), "/tmp/unrelated-project", "a", ["other project test coverage"]);
    writeSession(join(root, "b.jsonl"), matchingCwd, "b", ["security token and auth review"]);

    try {
      const result = discoverPersonalSpecialists({
        sessionRoot: root,
        cwdContains: matchingCwd,
        allowPastSessionDiscovery: true,
        outputDir: output,
        limitSessions: 1,
      });

      expect(result.enabled).toBe(true);
      expect(result.scannedSessions).toBe(1);
      expect(result.candidates.map((item) => item.roleId)).toContain("personal-security");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues a background refresh and exposes cached status immediately", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-specialist-discovery-cache-"));
    const cachePath = join(root, "cache.json");
    const outputDir = join(root, "output");
    const cwd = "/Users/pavel/repos/fiale-plus/worktrees/pi-rogue-issue225-personal-specialists";
    writeSession(join(root, "s1.jsonl"), cwd, "s1", ["security token and auth review"]);

    try {
      const result = queuePersonalSpecialistDiscoveryRefresh({
        sessionRoot: root,
        cwdContains: cwd,
        allowPastSessionDiscovery: true,
        cachePath,
        outputDir,
      });

      expect(result.queued).toBe(true);
      expect(result.snapshot.refreshingAt).toBeDefined();
      expect(formatPersonalSpecialistDiscoverySnapshot(result.snapshot)).toContain("queued at");
      expect(loadPersonalSpecialistDiscoverySnapshot(cachePath).refreshingAt).toBeDefined();

      let snapshot = loadPersonalSpecialistDiscoverySnapshot(cachePath);
      for (let i = 0; i < 100 && (!snapshot.result || snapshot.refreshingAt); i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        snapshot = loadPersonalSpecialistDiscoverySnapshot(cachePath);
      }

      expect(snapshot.refreshingAt).toBeUndefined();
      expect(snapshot.result?.candidates.map((item) => item.roleId)).toContain("personal-security");
      expect(formatPersonalSpecialistDiscoverySnapshot(snapshot)).toContain("Cached candidates:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
