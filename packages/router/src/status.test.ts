import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

function ctx() {
  return { sessionManager: { getSessionFile: () => "/tmp/pi-rogue-status/router-session.jsonl" } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("routerFeatureStatus", () => {
  it("reports unconfigured without creating router state", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-router-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { routerFeatureStatus } = await import("./status.js");

    expect(routerFeatureStatus(ctx())).toMatchObject({
      schema: "FeatureStatusV1",
      feature: "router",
      health: "unconfigured",
      enabled: false,
      mode: "observe",
    });
    expect(existsSync(join(home, ".pi", "agent", "pi-rogue"))).toBe(false);
  });

  it("keeps id-only session state isolated", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-router-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const config = await import("./config.js");
    const { routerFeatureStatus } = await import("./status.js");
    const configPath = config.routerGlobalConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ enabled: true, mode: "observe" }), "utf8");

    const first = { session: { id: "session-a" } };
    const second = { session: { id: "session-b" } };
    const firstStatePath = config.routerStatePath(first);
    const secondStatePath = config.routerStatePath(second);
    expect(firstStatePath).toBe(config.routerStatePath({ session: { id: "session-a" } }));
    expect(firstStatePath).not.toBe(secondStatePath);

    const hostileIdPath = config.routerStatePath({ session: { id: "../outside/session" } });
    expect(hostileIdPath).toContain(join(home, ".pi", "agent", "pi-rogue", "router", "sessions"));
    expect(hostileIdPath).not.toContain("../outside");
    mkdirSync(dirname(firstStatePath), { recursive: true });
    writeFileSync(firstStatePath, JSON.stringify({ lastDecisionAction: "continue" }), "utf8");

    expect(routerFeatureStatus(first)).toMatchObject({ health: "ready", diagnostics: { sessionScoped: true } });
    expect(routerFeatureStatus(second)).toMatchObject({ health: "idle", diagnostics: { sessionScoped: true } });
  });

  it("reports disabled and reads corrupt/newer state without writing", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-rogue-router-status-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const config = await import("./config.js");
    const { routerFeatureStatus } = await import("./status.js");
    const path = config.routerGlobalConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabled: false }), "utf8");
    expect(routerFeatureStatus(ctx()).health).toBe("disabled");

    writeFileSync(path, JSON.stringify({ enabled: true, mode: "observe" }), "utf8");
    expect(routerFeatureStatus({}).health).toBe("degraded");

    const enabled = { enabled: true, mode: "observe" };
    writeFileSync(path, JSON.stringify(enabled), "utf8");
    const statePath = config.routerStatePath(ctx());
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ futureField: true, lastDecisionAction: "continue" }), "utf8");
    expect(routerFeatureStatus(ctx())).toMatchObject({ health: "ready", enabled: true });

    writeFileSync(statePath, "{not-json", "utf8");
    expect(routerFeatureStatus(ctx()).health).toBe("error");

    writeFileSync(statePath, "null", "utf8");
    expect(routerFeatureStatus(ctx()).health).toBe("error");

    writeFileSync(statePath, JSON.stringify({ lastDecisionAction: 42 }), "utf8");
    expect(routerFeatureStatus(ctx())).toMatchObject({ health: "error", diagnostics: { stateValid: false } });

    writeFileSync(path, JSON.stringify({ enabled: true, profiles: { broken: null } }), "utf8");
    expect(routerFeatureStatus(ctx())).toMatchObject({
      health: "error",
      diagnostics: { configValid: false, stateValid: false },
    });

    writeFileSync(path, JSON.stringify({ enabled: "false" }), "utf8");
    expect(routerFeatureStatus(ctx())).toMatchObject({ health: "error", diagnostics: { configValid: false } });
  });
});
