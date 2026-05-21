import { featureFile, readJson, writeJson } from "@fiale-plus/pi-core";

export type GuardrailsMode = "ask" | "block" | "allow";

export interface GuardrailsConfig {
  mode: GuardrailsMode;
  llmReview: {
    enabled: boolean;
  };
  extraDangerousFragments: string[];
}

const CONFIG_FILE = featureFile("guardrails", "config.json");

const DEFAULT_CONFIG: GuardrailsConfig = {
  mode: "ask",
  llmReview: {
    enabled: false,
  },
  extraDangerousFragments: [],
};

function normalizeMode(mode: unknown): GuardrailsMode {
  return mode === "allow" || mode === "block" || mode === "ask" ? mode : "ask";
}

export function normalizeGuardrailsConfig(value: Partial<GuardrailsConfig>): GuardrailsConfig {
  return {
    mode: normalizeMode(value.mode),
    llmReview: {
      enabled: Boolean(value.llmReview?.enabled),
    },
    extraDangerousFragments: Array.isArray(value.extraDangerousFragments)
      ? value.extraDangerousFragments.map(String).map((fragment) => fragment.trim()).filter(Boolean)
      : [],
  };
}

export function loadGuardrailsConfig(): GuardrailsConfig {
  return normalizeGuardrailsConfig(readJson(CONFIG_FILE, DEFAULT_CONFIG));
}

export function saveGuardrailsConfig(config: GuardrailsConfig): GuardrailsConfig {
  const normalized = normalizeGuardrailsConfig(config);
  writeJson(CONFIG_FILE, normalized);
  return normalized;
}

export function guardrailsConfigPath(): string {
  return CONFIG_FILE;
}
