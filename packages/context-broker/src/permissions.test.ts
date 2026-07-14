import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileContextBroker } from "./file.js";
import { createSqliteContextBroker } from "./sqlite.js";

const mode = (path: string) => lstatSync(path).mode & 0o777;
const input = { sessionId: "permission-test", kind: "tool_output" as const, payload: "synthetic secret payload" };

describe("context broker artifact permissions", () => {
  it("secures JSONL metadata, blobs, and pre-existing directories under a permissive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-file-permissions-"));
    const dir = join(root, "store");
    const previous = process.umask(0o022);
    try {
      const broker = createFileContextBroker({ dir });
      const artifact = broker.publish(input);
      const blob = join(dir, "blobs", `${artifact.sha256}.txt`);
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(dir, "blobs"))).toBe(0o700);
      expect(mode(join(dir, "metadata.jsonl"))).toBe(0o600);
      expect(mode(blob)).toBe(0o600);

      chmodSync(dir, 0o755);
      chmodSync(join(dir, "metadata.jsonl"), 0o644);
      createFileContextBroker({ dir });
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(dir, "metadata.jsonl"))).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("secures SQLite database and sidecars under a permissive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-sqlite-permissions-"));
    const dir = join(root, "store");
    const path = join(dir, "artifacts.sqlite");
    const previous = process.umask(0o022);
    try {
      const broker = createSqliteContextBroker({ path });
      broker.publish(input);
      expect(mode(dir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);
      const sidecars = readdirSync(dir).filter((name) => /^artifacts\.sqlite-(?:wal|shm|journal)$/.test(name));
      expect(sidecars.length).toBeGreaterThan(0);
      for (const sidecar of sidecars) expect(mode(join(dir, sidecar))).toBe(0o600);

      chmodSync(path, 0o644);
      createSqliteContextBroker({ path });
      expect(mode(path)).toBe(0o600);
      expect(existsSync(path)).toBe(true);
    } finally {
      process.umask(previous);
    }
  });
});
