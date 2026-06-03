import { featureFile, readJson, writeJson } from "@fiale-plus/pi-core";

export type GuardrailsMode = "off" | "ask" | "block" | "allow";

export interface GuardrailsConfig {
  mode: GuardrailsMode;
  llmReview: {
    enabled: boolean;
    model?: string;
  };
  /**
   * When true, "warn"-level findings still trigger confirmation.
   * When false, "warn" only records the risk and is auto-allowed in ask mode.
   */
  askOnWarn: boolean;
  extraDangerousFragments: string[];
}

const CONFIG_FILE = featureFile("guardrails", "config.json");

const DEFAULT_CONFIG: GuardrailsConfig = {
  mode: "ask",
  llmReview: {
    enabled: false,
  },
  askOnWarn: false,
  extraDangerousFragments: [],
};

function normalizeMode(mode: unknown): GuardrailsMode {
  return mode === "off" || mode === "allow" || mode === "block" || mode === "ask"
    ? mode
    : "ask";
}

export function normalizeGuardrailsConfig(value: Partial<GuardrailsConfig>): GuardrailsConfig {
  const normalizedFragments = Array.isArray(value.extraDangerousFragments)
    ? [...new Set(value.extraDangerousFragments.map(String).map((fragment) => fragment.trim()).filter(Boolean))]
    : [];

  const normalizedModel = typeof value.llmReview?.model === "string" ? value.llmReview.model.trim() : undefined;
  const canonicalModel = normalizedModel
    ? (["local", "tiny", "binary"].includes(normalizedModel.toLowerCase())
      ? "local"
      : normalizedModel)
    : undefined;

  return {
    mode: normalizeMode(value.mode),
    llmReview: {
      enabled: Boolean(value.llmReview?.enabled),
      model: canonicalModel,
    },
    askOnWarn: Boolean(value.askOnWarn),
    extraDangerousFragments: normalizedFragments,
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
