type HeadersMap = Record<string, string>;

import type {
  GatewaySubstrate,
  SubstrateChatRequest,
  SubstrateChatResult,
  SubstrateCostQuote,
  SubstrateModel,
  SubstrateUsage,
} from "./substrate.js";

export interface OpenAICompatibleSubstrateOptions {
  id?: string;
  baseUrl: string;
  defaultHeaders?: HeadersMap;
  timeoutMs?: number;
}

interface OpenAIModelListResponse {
  data?: Array<{ id: string; object?: string; [key: string]: unknown }>;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  object?: string;
  choices?: Array<{ message?: unknown; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAICompatibleSubstrate implements GatewaySubstrate {
  readonly id: string;

  constructor(private readonly options: OpenAICompatibleSubstrateOptions) {
    this.id = options.id ?? "substrate-openai-compatible";
  }

  private headers(): HeadersMap {
    return {
      "content-type": "application/json",
      ...(this.options.defaultHeaders ?? {}),
    };
  }

  async listModels(): Promise<SubstrateModel[]> {
    const response = await fetchWithTimeout(
      `${this.options.baseUrl.replace(/\/+$/, "")}/models`,
      {
        method: "GET",
        headers: this.headers(),
      },
      this.options.timeoutMs ?? 2_000,
    );

    if (!response.ok) {
      throw new Error(`listModels failed (${response.status} ${response.statusText})`);
    }

    const body = (await response.json()) as OpenAIModelListResponse;
    const data = Array.isArray(body.data) ? body.data : [];
    return data.map((row) => ({ id: String(row.id), object: row.object }));
  }

  async callChat(req: SubstrateChatRequest): Promise<SubstrateChatResult> {
    const response = await fetchWithTimeout(
      `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: req.stream,
          max_tokens: req.max_tokens,
          temperature: req.temperature,
          metadata: req.metadata,
        }),
      },
      this.options.timeoutMs ?? 2_000,
    );

    const body = (await response.json()) as OpenAIChatResponse;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        model: req.model,
        content: body,
        rawResponse: body,
      };
    }

    return {
      ok: true,
      status: response.status,
      model: body.model ?? req.model,
      usage: body.usage,
      content: body,
      rawResponse: body,
    };
  }

  async estimateCost(req: { model: string; inputTokensApprox: number; outputTokensApprox: number; cachedInputTokensApprox?: number }): Promise<SubstrateCostQuote> {
    const _ = req.model;
    const _input = req.inputTokensApprox;
    const _output = req.outputTokensApprox;
    const _cached = req.cachedInputTokensApprox ?? 0;

    return {
      inputCostUsdPerMTok: 0,
      outputCostUsdPerMTok: 0,
      cachedInputCostUsdPerMTok: 0,
      currency: "USD",
    };
  }

  async getUsage(runId: string): Promise<SubstrateUsage | null> {
    return {
      runId,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billedTokens: 0,
    };
  }
}
