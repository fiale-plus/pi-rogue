import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOwnerOnlyDirectory, secureWriteFile } from "./secure-fs.js";
import { appendText, writeText } from "./storage.js";

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("owner-only artifact storage", () => {
  it("creates and tightens directories and shared state independent of umask", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-secure-fs-"));
    const dir = join(root, "state");
    const file = join(dir, "shared.jsonl");
    const previous = process.umask(0o022);
    try {
      ensureOwnerOnlyDirectory(dir);
      writeText(file, "one\n");
      appendText(file, "two\n");
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");

      chmodSync(dir, 0o755);
      chmodSync(file, 0o644);
      ensureOwnerOnlyDirectory(dir);
      secureWriteFile(file, "tightened\n");
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("refuses symbolic-link directory and file targets", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-secure-links-"));
    const realDir = join(root, "real");
    ensureOwnerOnlyDirectory(realDir);
    const linkedDir = join(root, "linked");
    symlinkSync(realDir, linkedDir, "dir");
    expect(() => ensureOwnerOnlyDirectory(linkedDir)).toThrow(/symbolic-link/);
    expect(() => ensureOwnerOnlyDirectory(join(linkedDir, "nested", "state"))).toThrow(/symbolic-link.*component/);

    const realFile = join(realDir, "real.txt");
    writeFileSync(realFile, "safe", { mode: 0o600 });
    const linkedFile = join(realDir, "linked.txt");
    symlinkSync(realFile, linkedFile, "file");
    expect(() => secureWriteFile(linkedFile, "unsafe")).toThrow(/symbolic-link/);
    expect(readFileSync(realFile, "utf8")).toBe("safe");
  });
});
