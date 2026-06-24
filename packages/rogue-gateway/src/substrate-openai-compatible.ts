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
  apiKey?: string;
  authHeaderName?: string;
  authScheme?: string;
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeHeaderName(name: string | undefined): string {
  const trimmed = String(name ?? "").trim();
  return trimmed.length > 0 ? trimmed : "Authorization";
}

function authHeaderValue(apiKey: string, authHeaderName?: string, authScheme?: string): string {
  const header = normalizeHeaderName(authHeaderName);
  if (header.toLowerCase() === "authorization") {
    return `${authScheme ?? "Bearer"} ${apiKey}`.trim();
  }

  return apiKey;
}

export class OpenAICompatibleSubstrate implements GatewaySubstrate {
  readonly id: string;

  constructor(private readonly options: OpenAICompatibleSubstrateOptions) {
    this.id = options.id ?? "substrate-openai-compatible";
  }

  private baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private headers(): HeadersMap {
    const headers: HeadersMap = {
      "content-type": "application/json",
      ...(this.options.defaultHeaders ?? {}),
    };

    if (this.options.apiKey) {
      headers[normalizeHeaderName(this.options.authHeaderName)] = authHeaderValue(
        this.options.apiKey,
        this.options.authHeaderName,
        this.options.authScheme,
      );
    }

    return headers;
  }

  private candidateUrls(endpoint: string): string[] {
    const base = this.baseUrl();
    return unique([
      `${base}${endpoint}`,
      `${base}/v1${endpoint}`,
    ]);
  }

  private async requestWithFallback(
    endpoint: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const urls = this.candidateUrls(endpoint);
    let fallbackResponse: Response | undefined;
    let lastError: unknown;

    for (const url of urls) {
      try {
        const response = await fetchWithTimeout(url, init, timeoutMs);
        if (response.status !== 404) {
          return response;
        }

        fallbackResponse = response;
      } catch (error) {
        lastError = error;
      }
    }

    if (fallbackResponse) {
      return fallbackResponse;
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`request to openai-compatible substrate failed for ${endpoint}`);
  }

  private async parseBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  async listModels(): Promise<SubstrateModel[]> {
    const response = await this.requestWithFallback(
      "/models",
      {
        method: "GET",
        headers: this.headers(),
      },
      this.options.timeoutMs ?? 2_000,
    );

    const body = (await this.parseBody(response)) as OpenAIModelListResponse;

    if (!response.ok) {
      throw new Error(`listModels failed (${response.status} ${response.statusText})`);
    }

    const data = Array.isArray((body as OpenAIModelListResponse | undefined)?.data)
      ? ((body as OpenAIModelListResponse).data ?? [])
      : [];

    return data.map((row) => ({ id: String(row.id), object: row.object }));
  }

  async callChat(req: SubstrateChatRequest): Promise<SubstrateChatResult> {
    const response = await this.requestWithFallback(
      "/chat/completions",
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

    const body = (await this.parseBody(response)) as OpenAIChatResponse;

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
      model: body && typeof body === "object" ? body.model ?? req.model : req.model,
      usage: body && typeof body === "object" ? body.usage : undefined,
      content: body,
      rawResponse: body,
    };
  }

  async estimateCost(req: {
    model: string;
    inputTokensApprox: number;
    outputTokensApprox: number;
    cachedInputTokensApprox?: number;
  }): Promise<SubstrateCostQuote> {
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
