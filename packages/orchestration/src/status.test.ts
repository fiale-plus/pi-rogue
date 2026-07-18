import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionIdentity } from "@fiale-plus/pi-core";

function ctx() {
  return { sessionManager: { getSessionFile: () => "/tmp/pi-rogue-status/orchestration-session.jsonl" } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("orchestrationFeatureStatus", () => {
  it("reports idle without creating session state", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { orchestrationFeatureStatus } = await import("./status.js");

    expect(orchestrationFeatureStatus(ctx())).toMatchObject({
      schema: "FeatureStatusV1",
      feature: "orchestration",
      health: "idle",
      enabled: true,
      mode: "idle",
    });
    expect(orchestrationFeatureStatus({}).health).toBe("degraded");
    expect(existsSync(join(home, ".pi", "agent", "fiale-plus"))).toBe(false);
  });

  it("reads legacy state without migrating it", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { orchestrationFeatureStatus } = await import("./status.js");
    const { sessionIdentity: currentSessionIdentity } = await import("@fiale-plus/pi-core");
    const legacyDir = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration", currentSessionIdentity(ctx()).legacyKey);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, ".pi-rogue-v2-claim"), `${currentSessionIdentity(ctx()).key}\n`, "utf8");
    writeFileSync(join(legacyDir, "goal.md"), "legacy goal\n", "utf8");

    expect(orchestrationFeatureStatus(ctx())).toMatchObject({ health: "ready", mode: "active" });
    expect(existsSync(join(legacyDir, "goal.md"))).toBe(true);
    expect(existsSync(join(homedir(), ".pi", "agent", "fiale-plus", "orchestration", currentSessionIdentity(ctx()).key))).toBe(false);
  });

  it("does not read legacy state claimed by another session", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { orchestrationFeatureStatus } = await import("./status.js");
    const { sessionIdentity: currentSessionIdentity } = await import("@fiale-plus/pi-core");
    const legacyDir = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration", currentSessionIdentity(ctx()).legacyKey);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, ".pi-rogue-v2-claim"), "another-session\n", "utf8");
    writeFileSync(join(legacyDir, "goal.md"), "foreign goal\n", "utf8");

    expect(orchestrationFeatureStatus(ctx())).toMatchObject({ health: "idle", mode: "idle" });
  });

  it("reports unsafe v2 state as an error without following symlinks", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-status-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-outside-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { orchestrationFeatureStatus } = await import("./status.js");
    const { sessionIdentity: currentSessionIdentity } = await import("@fiale-plus/pi-core");
    const currentDir = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration", currentSessionIdentity(ctx()).key);
    mkdirSync(dirname(currentDir), { recursive: true });
    symlinkSync(outside, currentDir, "dir");

    expect(orchestrationFeatureStatus(ctx()).health).toBe("error");
  });

  it("reports active newer state and corrupt state without migration writes", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-orchestration-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { orchestrationFeatureStatus } = await import("./status.js");
    const { sessionIdentity: currentSessionIdentity } = await import("@fiale-plus/pi-core");
    const sessionDir = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration", currentSessionIdentity(ctx()).key);
    const loopPath = join(sessionDir, "loop.json");
    mkdirSync(dirname(loopPath), { recursive: true });
    writeFileSync(loopPath, JSON.stringify({ enabled: true, interval: "5m" }), "utf8");
    expect(orchestrationFeatureStatus(ctx())).toMatchObject({ health: "idle", mode: "idle" });

    writeFileSync(loopPath, JSON.stringify({ enabled: true, interval: "5m", instruction: "keep working", futureField: "ignored" }), "utf8");
    expect(orchestrationFeatureStatus(ctx())).toMatchObject({ health: "ready", mode: "active" });
    expect((orchestrationFeatureStatus(ctx()).diagnostics as any).loopActive).toBe(true);

    writeFileSync(loopPath, JSON.stringify({ enabled: "false", instruction: "work" }), "utf8");
    expect(orchestrationFeatureStatus(ctx()).health).toBe("error");

    writeFileSync(loopPath, JSON.stringify({ enabled: true, interval: "1s", instruction: "work" }), "utf8");
    expect(orchestrationFeatureStatus(ctx()).health).toBe("error");

    writeFileSync(loopPath, JSON.stringify({ enabled: true, interval: "5m", instruction: "keep working" }), "utf8");
    writeFileSync(join(sessionDir, "worker.json"), "{not-json", "utf8");
    expect(orchestrationFeatureStatus(ctx()).health).toBe("error");
  });
});
