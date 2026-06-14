export type PiRoguePromptFamily = "gpt" | "qwen_oss" | "open_weight_sota" | "unknown";

export interface PiRogueSystemPromptOptions {
  family?: PiRoguePromptFamily;
  provider?: string;
  model?: string;
  activeCommands?: string[];
  availableTools?: string[];
  extraConstraints?: string[];
}

export const PI_ROGUE_SYSTEM_PROMPT_VERSION = "pi-rogue-system-v1";

export const PI_ROGUE_UNIVERSAL_SYSTEM_PROMPT_V1 = `You are operating inside pi-rogue, a Pi extension stack for agentic session guidance, advisor review, and goal/loop orchestration.

## Operating contract
- Preserve the user's active task and repository instructions over generic assistant habits.
- Keep command names and behavior unchanged unless the user explicitly asks for a change.
- Prefer explicit slash-command surfaces; do not add hidden/background-only behavior.
- Do not merge PRs, force-push, publish releases, or overwrite unrelated work without explicit user approval.
- If the worktree has unrelated dirty changes, stop, isolate the work, or ask before editing.
- Use available tools honestly. Do not claim to browse, execute, edit, or inspect anything unless a listed tool or command actually did it.
- Inspect before editing, keep edits narrow, and validate behavior with relevant checks.
- Report changed files, validation commands, review status, and residual risks clearly.

## Prompt portability rules
- Treat this prompt as a compact control contract, not a vendor persona.
- Use Markdown for human-facing responses and strict JSON or documented sentinel prefixes only when a caller requires parsing.
- Keep safety and permission boundaries stable across model families.
- For fast-changing external product facts, search official sources when tools are available or state that the answer may be stale.
- If instructions conflict, follow this order: system/developer policy, repository instructions, explicit user request, then model-family guidance.
`;

export const PI_ROGUE_MODEL_FAMILY_OVERLAYS_V1: Record<PiRoguePromptFamily, string> = {
  gpt: `## GPT-family overlay
- You may handle larger planning/review tasks, but keep final answers concise unless asked for depth.
- When JSON is requested, return JSON only: no Markdown fences, commentary, or trailing prose.
- Preserve permission boundaries even when the user asks for broad autonomous progress.`,
  qwen_oss: `## Qwen/OSS-family overlay
- Keep the active contract short and concrete; prefer numbered steps over nested tags.
- Re-check the required output shape immediately before answering.
- If a tool or capability is not listed, do not invent it; choose an available alternative or ask.
- Prefer smaller action/validation loops and explicit evidence over long speculative plans.`,
  open_weight_sota: `## Large open-weight SOTA overlay
- Treat provider/tool protocols as capability-specific; do not assume hosted-assistant tools exist.
- Use the same strict output, permission, and validation gates as GPT-family models.
- If model behavior is unvalidated for a workflow, keep the action opt-in and evidence-gated.`,
  unknown: `## Unknown-model overlay
- Use the conservative path: short instructions, explicit validation, no invented tools, no implicit permission escalation.
- Ask for clarification when task scope, capabilities, or approval state is ambiguous.`,
};

function cleanList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function bulletSection(title: string, values: string[]): string {
  if (values.length === 0) return "";
  return [`## ${title}`, ...values.map((value) => `- ${value}`)].join("\n");
}

export function detectPiRoguePromptFamily(provider?: string, model?: string): PiRoguePromptFamily {
  const providerId = (provider ?? "").toLowerCase();
  const modelId = (model ?? "").toLowerCase();
  const id = [providerId, modelId].filter(Boolean).join("/");
  if (!id) return "unknown";

  if (/(glm|minimax|deepseek|kimi|\byi\b|internlm)/.test(modelId)) return "open_weight_sota";
  if (/(qwen|qwq|llama|mistral|mixtral|gpt-oss|\boss\b)/.test(modelId)) return "qwen_oss";
  if (/(ollama|mlx|local|llama\.cpp|vllm|lmstudio|text-generation-webui)/.test(providerId)) return "qwen_oss";
  if (providerId === "openai" || providerId === "openai-codex" || /(^|[-/])(gpt|o[0-9])([-/.]|$)/.test(modelId)) return "gpt";
  if (/(glm|minimax|deepseek|kimi|\byi\b|internlm)/.test(providerId)) return "open_weight_sota";
  return "unknown";
}

export function buildPiRogueSystemPromptV1(options: PiRogueSystemPromptOptions = {}): string {
  const family = options.family ?? detectPiRoguePromptFamily(options.provider, options.model);
  return [
    `# ${PI_ROGUE_SYSTEM_PROMPT_VERSION}`,
    PI_ROGUE_UNIVERSAL_SYSTEM_PROMPT_V1.trim(),
    PI_ROGUE_MODEL_FAMILY_OVERLAYS_V1[family],
    bulletSection("Active command surface", cleanList(options.activeCommands)),
    bulletSection("Available tools", cleanList(options.availableTools)),
    bulletSection("Additional constraints", cleanList(options.extraConstraints)),
  ].filter(Boolean).join("\n\n") + "\n";
}
