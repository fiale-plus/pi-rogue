import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("advisorFeatureStatus", () => {
  it("reports built-in defaults without creating state", async () => {
    const home = mkdtempSync(join(mkdtempSync(join("/tmp", "pi-rogue-advisor-status-")), "home-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { advisorFeatureStatus } = await import("./status.js");

    expect(advisorFeatureStatus()).toMatchObject({
      schema: "FeatureStatusV1",
      feature: "advisor",
      health: "unconfigured",
      enabled: true,
      mode: "auto",
    });
    expect(existsSync(join(home, ".pi", "agent", "pi-rogue"))).toBe(false);
  });

  it("reports disabled and malformed config without exposing paths", async () => {
    const home = mkdtempSync(join("/tmp", "pi-rogue-advisor-status-"));
    vi.stubEnv("HOME", home);
    const dir = join(home, ".pi", "agent", "pi-rogue", "advisor");
    mkdirSync(dir, { recursive: true });
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ mode: "off" }), "utf8");
    vi.resetModules();
    const { advisorFeatureStatus } = await import("./status.js");
    expect(advisorFeatureStatus()).toMatchObject({ health: "disabled", enabled: false, mode: "off" });
    expect(JSON.stringify(advisorFeatureStatus())).not.toContain(home);

    writeFileSync(config, "{not-json", "utf8");
    expect(advisorFeatureStatus().health).toBe("error");

    writeFileSync(config, JSON.stringify({ mode: "../unsafe" }), "utf8");
    expect(advisorFeatureStatus()).toMatchObject({ health: "error", mode: "auto" });
  });
});
