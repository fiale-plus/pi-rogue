export const SUBSTRATE_SCHEMA = "pi-rogue-gateway.substrate.v1" as const;

export interface SubstrateModel {
  id: string;
  provider?: string;
  object?: string;
  owned?: boolean;
  maxTokens?: number;
}

export interface SubstrateChatRequest {
  model: string;
  messages: unknown[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface SubstrateCostQuote {
  inputCostUsdPerMTok: number;
  outputCostUsdPerMTok: number;
  cachedInputCostUsdPerMTok?: number;
  currency?: string;
}

export interface SubstrateUsage {
  runId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  billedTokens?: number;
}

export interface SubstrateChatResult {
  ok: boolean;
  status?: number;
  content?: unknown;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  rawResponse?: unknown;
}

export interface GatewaySubstrate {
  id: string;
  listModels(): Promise<SubstrateModel[]>;
  callChat(req: SubstrateChatRequest): Promise<SubstrateChatResult>;
  estimateCost?(
    req: {
      model: string;
      inputTokensApprox: number;
      outputTokensApprox: number;
      cachedInputTokensApprox?: number;
    },
  ): Promise<SubstrateCostQuote>;

  getUsage?(runId: string): Promise<SubstrateUsage | null>;
}
