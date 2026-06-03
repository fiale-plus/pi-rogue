import { describe, expect, it } from "vitest";
import { classifyReversible } from "./restore-ledger.js";
import { scanShellCommand, type RiskScan } from "@fiale-plus/pi-core";

describe("classifyReversible", () => {
  const baseDanger: RiskScan = scanShellCommand("rm oldfile.txt", []);

  it("marks git restore commands as reversible", () => {
    expect(classifyReversible("git restore file.txt", baseDanger)).toBe(true);
    expect(classifyReversible("git checkout HEAD~1", baseDanger)).toBe(true);
  });

  it("marks simple rm as reversible candidate", () => {
    expect(classifyReversible("rm oldfile.txt", baseDanger)).toBe(true);
    expect(classifyReversible("rm -f oldfile.txt", baseDanger)).toBe(true);
  });

  it("marks non-dangerous commands as non-reversible", () => {
    expect(classifyReversible("echo hello", { ...baseDanger, severity: "warn", safe: true })).toBe(false);
  });
});
