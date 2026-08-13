import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFeatureStatusV1, serializeFeatureStatusV1, type FeatureStatusV1 } from "@fiale-plus/pi-core";

function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-rogue", "advisor", "config.json");
}

const MODES = new Set(["auto", "manual", "off"]);

function readAdvisorConfig(): { present: boolean; valid: boolean; mode?: string } {
  const path = configPath();
  if (!existsSync(path)) return { present: false, valid: true };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { present: true, valid: false };
    const mode = (value as Record<string, unknown>).mode;
    const valid = mode === undefined || (typeof mode === "string" && MODES.has(mode));
    return { present: true, valid, mode: valid && typeof mode === "string" ? mode : undefined };
  } catch {
    return { present: true, valid: false };
  }
}

/** Read-only Advisor status adapter. It never creates, migrates, or writes state. */
export function advisorFeatureStatus(): FeatureStatusV1 {
  const config = readAdvisorConfig();
  const mode = config.mode ?? "auto";
  const enabled = mode !== "off";
  const health = !config.present ? "unconfigured" : !config.valid ? "error" : !enabled ? "disabled" : "ready";
  return createFeatureStatusV1({
    feature: "advisor",
    owner: "advisor",
    health,
    enabled,
    mode,
    summary: !config.present ? "advisor uses built-in defaults" : enabled ? "advisor is available" : "advisor is disabled",
    diagnostics: {
      configPresent: config.present,
      configValid: config.valid,
    },
  });
}

export function serializeAdvisorFeatureStatus(): string {
  return serializeFeatureStatusV1(advisorFeatureStatus());
}
