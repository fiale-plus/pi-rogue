import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FusionRecipe, ParsedModelRef } from "./types.js";

const MAX_PANEL_MODELS = 8;
const MAX_COMPLETION_TOKENS = 64_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanNonNegativeInt(value: unknown, field: string, max: number, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    errors.push(`${field} must be a non-negative integer`);
    return undefined;
  }
  if (n > max) {
    errors.push(`${field} must be <= ${max}`);
    return undefined;
  }
  return n;
}

export function parseModelRef(value: string): ParsedModelRef {
  const ref = String(value ?? "").trim();
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`model reference must use provider/model form: ${ref || "(empty)"}`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export function isFusionModelRef(value: string): boolean {
  try {
    return parseModelRef(value).provider === "fusion";
  } catch {
    return false;
  }
}

export function validateFusionRecipe(raw: unknown): { ok: true; recipe: FusionRecipe } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["recipe must be an object"] };

  const schema = raw.schema === undefined ? "pi-rogue.fusion.recipe.v1" : raw.schema;
  if (schema !== "pi-rogue.fusion.recipe.v1") errors.push("schema must be pi-rogue.fusion.recipe.v1");
  if (raw.kind !== "fusion") errors.push("kind must be fusion");

  const id = cleanString(raw.id);
  if (!id) errors.push("id is required");
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) errors.push("id must be a safe slug (letters, numbers, dot, underscore, dash)");

  const model = cleanString(raw.model);
  if (!model) errors.push("model is required");

  const analysisModelsRaw = Array.isArray(raw.analysis_models) ? raw.analysis_models : undefined;
  if (!analysisModelsRaw) errors.push("analysis_models must be an array");
  const analysis_models = (analysisModelsRaw ?? []).map(cleanString).filter((entry): entry is string => Boolean(entry));
  if (analysis_models.length === 0) errors.push("analysis_models must include at least one model");
  if ((analysisModelsRaw ?? []).length !== analysis_models.length) errors.push("analysis_models entries must be non-empty strings");
  if (analysis_models.length > MAX_PANEL_MODELS) errors.push(`analysis_models must include <= ${MAX_PANEL_MODELS} models`);

  const allRefs = [model, ...analysis_models].filter((entry): entry is string => Boolean(entry));
  for (const ref of allRefs) {
    try {
      parseModelRef(ref);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (allRefs.some((ref) => isFusionModelRef(ref))) errors.push("fusion/* model refs are recursive and not allowed in recipes");

  const max_tool_calls = cleanNonNegativeInt(raw.max_tool_calls, "max_tool_calls", 64, errors);
  const max_completion_tokens = cleanNonNegativeInt(raw.max_completion_tokens, "max_completion_tokens", MAX_COMPLETION_TOKENS, errors);
  const timeout_ms = cleanNonNegativeInt(raw.timeout_ms, "timeout_ms", MAX_TIMEOUT_MS, errors);
  const per_model_timeout_ms = cleanNonNegativeInt(raw.per_model_timeout_ms, "per_model_timeout_ms", MAX_TIMEOUT_MS, errors);

  let temperature: number | undefined;
  if (raw.temperature !== undefined) {
    const n = Number(raw.temperature);
    if (!Number.isFinite(n) || n < 0 || n > 2) errors.push("temperature must be a number from 0 to 2");
    else temperature = n;
  }

  let reasoning: FusionRecipe["reasoning"];
  if (raw.reasoning !== undefined) {
    if (!isRecord(raw.reasoning)) {
      errors.push("reasoning must be an object");
    } else {
      const effort = raw.reasoning.effort;
      if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high") {
        errors.push("reasoning.effort must be low, medium, or high");
      }
      const max_tokens = cleanNonNegativeInt(raw.reasoning.max_tokens, "reasoning.max_tokens", MAX_COMPLETION_TOKENS, errors);
      reasoning = {
        ...(effort === "low" || effort === "medium" || effort === "high" ? { effort } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
      };
    }
  }

  const allow_partial_panel = raw.allow_partial_panel;
  if (allow_partial_panel !== undefined && typeof allow_partial_panel !== "boolean") {
    errors.push("allow_partial_panel must be boolean");
  }

  const min_panel_success = cleanNonNegativeInt(raw.min_panel_success, "min_panel_success", analysis_models.length, errors);
  if (min_panel_success !== undefined && min_panel_success < 1) {
    errors.push("min_panel_success must be at least 1");
  }

  if (raw.analysis_agents !== undefined) {
    errors.push("analysis_agents is not supported in kind=fusion; use kind=agent_fusion in a future release");
  }
  if ((raw as any).coordination !== undefined) {
    errors.push("coordination is not supported in kind=fusion; use kind=agent_fusion in a future release");
  }

  if (errors.length > 0 || !id || !model) return { ok: false, errors };
  return {
    ok: true,
    recipe: {
      schema: "pi-rogue.fusion.recipe.v1",
      kind: "fusion",
      id,
      model,
      analysis_models,
      ...(max_tool_calls !== undefined ? { max_tool_calls } : {}),
      ...(max_completion_tokens !== undefined ? { max_completion_tokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(reasoning && Object.keys(reasoning).length > 0 ? { reasoning } : {}),
      ...(timeout_ms !== undefined ? { timeout_ms } : {}),
      ...(per_model_timeout_ms !== undefined ? { per_model_timeout_ms } : {}),
      ...(typeof allow_partial_panel === "boolean" ? { allow_partial_panel } : {}),
      ...(min_panel_success !== undefined ? { min_panel_success } : {}),
    },
  };
}

export function validateFusionRecipes(raw: unknown): { ok: true; recipes: FusionRecipe[] } | { ok: false; errors: string[] } {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.recipes)
      ? raw.recipes
      : undefined;
  if (!list) return { ok: false, errors: ["recipes file must be an array or { recipes: [...] }"] };

  const recipes: FusionRecipe[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, index) => {
    const result = validateFusionRecipe(item);
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `recipes[${index}]: ${error}`));
      return;
    }
    if (seen.has(result.recipe.id)) {
      errors.push(`recipes[${index}]: duplicate id ${result.recipe.id}`);
      return;
    }
    seen.add(result.recipe.id);
    recipes.push(result.recipe);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, recipes };
}

export function fusionRecipePaths(_cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = cleanString(env.PI_ROGUE_FUSION_RECIPES);
  return [
    ...(configured ? [resolve(configured)] : []),
    join(homedir(), ".pi", "agent", "pi-rogue", "fusion", "recipes.json"),
  ].filter(Boolean);
}

export function defaultFusionRecipeWritePath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = cleanString(env.PI_ROGUE_FUSION_RECIPES);
  if (configured) return resolve(configured);
  const paths = fusionRecipePaths(cwd, env);
  return paths.find((path) => existsSync(path)) ?? paths[0] ?? join(homedir(), ".pi", "agent", "pi-rogue", "fusion", "recipes.json");
}

export function loadFusionRecipes(cwd: string, env: NodeJS.ProcessEnv = process.env): { recipes: FusionRecipe[]; path?: string; errors: string[] } {
  const paths = fusionRecipePaths(cwd, env);
  const first = paths.find((path) => existsSync(path));
  if (!first) return { recipes: [], errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(first, "utf8")) as unknown;
    const result = validateFusionRecipes(parsed);
    return result.ok ? { recipes: result.recipes, path: first, errors: [] } : { recipes: [], path: first, errors: result.errors };
  } catch (error) {
    return { recipes: [], path: first, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
