import { completeSimple, type ThinkingLevel } from "@earendil-works/pi-ai";
import { type RiskScan } from "@fiale-plus/pi-core";
import { binaryGatePredict } from "@fiale-plus/pi-rogue-advisor";

export type LlmVerdict = "allow" | "block" | "ask";

export interface LlmReviewResult {
  verdict: LlmVerdict;
  reasoning: string;
}

const REVISION_PROMPT = [
  "You are a command-risk reviewer for a terminal guardrail system.",
  "Given a shell command and existing risk findings, output strict JSON only:",
  '{ "verdict": "allow|ask|block", "reasoning": "short reason" }',
  "Classify as block only for clearly destructive or security-sensitive commands.",
  "Use ask for likely dangerous commands where confidence is mixed.",
  "Use allow only when the command is clearly safe enough.",
].join(" ");

const ALLOWED_VERDICTS = new Set<LlmVerdict>(["allow", "ask", "block"]);

interface RegistryModel {
  id: string;
  provider?: string;
  input?: string[];
}

const LOCAL_REVIEW_ALIASES = new Set(["local", "tiny", "binary", "binary-gate"]);

function isLocalReviewModel(model?: string): boolean {
  const value = String(model ?? "").trim().toLowerCase();
  return LOCAL_REVIEW_ALIASES.has(value);
}

function scoreToVerdict(score: number): LlmVerdict {
  if (score >= 0.75) return "block";
  if (score >= 0.55) return "ask";
  return "allow";
}

function localTinyReview(command: string, scan: RiskScan, extraFragments: string[]): LlmReviewResult {
  if (scan.safe) return { verdict: "allow", reasoning: scan.reason };
  if (scan.severity === "danger") return { verdict: "block", reasoning: scan.reason };

  const findings = scan.findings.map((finding) => finding.label).join(", ");
  const gate = binaryGatePredict(
    [
      `Command: ${command}`,
      `Findings: ${findings || "none"}`,
      `Extra fragments: ${extraFragments.length > 0 ? extraFragments.join(",") : "none"}`,
    ].join("\n"),
  );

  if (!gate) {
    return toHeuristicResult(scan);
  }

  const confidence = Math.max(0, Math.min(1, gate.confidence));
  const riskScore = gate.decision === "escalate" ? confidence : 1 - confidence;
  return {
    verdict: scoreToVerdict(riskScore),
    reasoning: `Local binary gate ${gate.decision} (${Math.round(gate.confidence * 100)}%).`,
  };
}

function responseText(response: { content?: Array<{ type?: string; text?: string }> } | null | undefined): string {
  return (response?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text).join("\n").trim();
}

function normalizeVerdict(value: string | null | undefined): LlmVerdict {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (ALLOWED_VERDICTS.has(normalized as LlmVerdict) ? normalized : "ask") as LlmVerdict;
}

function extractJsonBody(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return trimmed;
}

function parseReview(text: string): LlmReviewResult | null {
  try {
    const parsed = JSON.parse(extractJsonBody(text)) as { verdict?: unknown; reasoning?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const verdict = normalizeVerdict(typeof parsed.verdict === "string" ? parsed.verdict : undefined);
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";
    return {
      verdict,
      reasoning: reasoning || `model verdict: ${verdict}`,
    };
  } catch {
    return null;
  }
}

async function resolveTextModel(ctx: any, preferredModel?: string): Promise<RegistryModel | null> {
  if (isLocalReviewModel(preferredModel)) return null;

  const registry = ctx?.modelRegistry;
  if (!registry) return null;

  if (preferredModel) {
    const [provider, ...parts] = preferredModel.split("/");
    const model = String(parts.join("/")).trim();
    if (provider && model && parts.length > 0) {
      const found = await registry.find?.(provider, model);
      if (found) return found;
    }
  }

  const available = (registry.getAvailable?.() as Array<RegistryModel> | undefined) ?? [];
  const textModels = available.filter((entry) => entry?.input?.includes?.("text") && entry.id);
  if (!preferredModel) {
    const tiny = textModels.find((entry) => /text-light|tiny|small/i.test(entry.id));
    if (tiny) return tiny;
  }

  return textModels[0] ?? null;
}

function toHeuristicResult(scan: RiskScan): LlmReviewResult {
  if (scan.safe) return { verdict: "allow", reasoning: scan.reason };
  if (scan.severity === "danger") return { verdict: "block", reasoning: scan.reason };
  return { verdict: "ask", reasoning: scan.reason };
}

export async function llmReview(
  command: string,
  scan: RiskScan,
  extraFragments: string[],
  ctx: any,
  preferredModel?: string,
): Promise<LlmReviewResult> {
  if (isLocalReviewModel(preferredModel)) {
    return localTinyReview(
      command,
      scan,
      extraFragments
        .map((fragment) => String(fragment || "").trim())
        .filter(Boolean),
    );
  }

  const heuristic = toHeuristicResult(scan);

  const model = await resolveTextModel(ctx, preferredModel);
  if (!model) return heuristic;

  const auth = await ctx?.modelRegistry?.getApiKeyAndHeaders?.(model);
  if (!auth || (auth as { ok?: boolean }).ok === false) return heuristic;

  const normalizedFragments = extraFragments
    .map((fragment) => String(fragment || "").trim())
    .filter(Boolean);

  const findings = normalizedFragments.length
    ? scan.findings.map((finding) => finding.label).join(", ")
    : "(no extra fragments configured)";

  const message = [
    `Command: ${command}`,
    `Built-in findings: ${scan.findings.map((finding) => finding.label).join(", ")}`,
    `Extra-configured findings: ${findings}`,
    `Heuristic severity: ${scan.severity}`,
    `Severity rationale: ${scan.reason}`,
    `Use allow/ask/block in strict JSON only.`,
  ].join("\n");

  try {
    const response = await completeSimple(
      model as any,
      {
        systemPrompt: REVISION_PROMPT,
        messages: [{ role: "user", content: message, timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 160,
        reasoning: "low" as ThinkingLevel,
      },
    );

    const parsed = parseReview(responseText(response));
    if (!parsed) return heuristic;
    if (typeof parsed.reasoning === "string" && parsed.reasoning.includes("block")) {
      return parsed;
    }
    return parsed;
  } catch {
    return heuristic;
  }
}
