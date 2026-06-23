import { randomUUID } from "node:crypto";

import type { GatewaySubstrate, SubstrateChatRequest, SubstrateChatResult, SubstrateCostQuote, SubstrateModel, SubstrateUsage } from "./substrate.js";

export type MockModel = Pick<SubstrateModel, "id"> & Partial<SubstrateModel>;

export interface MockSubstrateOptions {
  models?: MockModel[];
  usageSeed?: SubstrateUsage[];
  latencyMs?: number;
}

function cloneUsage(usage: SubstrateUsage): SubstrateUsage {
  return {
    runId: usage.runId,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    billedTokens: usage.billedTokens,
  };
}

function pickRunId(metadata: SubstrateChatRequest["metadata"]): string | null {
  const runId = metadata?.runId;
  if (typeof runId === "string" && runId.length > 0) return runId;
  return null;
}

export class SubstrateMock implements GatewaySubstrate {
  private usages: Map<string, SubstrateUsage> = new Map();

  constructor(
    public readonly id = "substrate-mock",
    private readonly options: MockSubstrateOptions = {},
  ) {
    if (options.usageSeed) {
      for (const usage of options.usageSeed) {
        this.usages.set(usage.runId, cloneUsage(usage));
      }
    }
  }

  async listModels(): Promise<SubstrateModel[]> {
    const models = this.options.models;
    if (models && models.length > 0) return models;
    return [
      { id: "mock-generic", object: "model", maxTokens: 32000 },
      { id: "mock-fast", object: "model", maxTokens: 12000 },
    ];
  }

  async callChat(req: SubstrateChatRequest): Promise<SubstrateChatResult> {
    const latencyMs = this.options.latencyMs ?? 0;
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    const runId = pickRunId(req.metadata) ?? randomUUID();
    const input = Array.isArray(req.messages) ? req.messages.length : 0;
    const usage: SubstrateUsage = {
      runId,
      promptTokens: Math.max(0, input * 50),
      completionTokens: 42,
      totalTokens: Math.max(0, input * 50) + 42,
      billedTokens: Math.max(0, input * 50) + 42,
    };

    this.usages.set(runId, usage);

    return {
      ok: true,
      status: 200,
      model: req.model,
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
      content: {
        role: "assistant",
        content: `mock:${req.model}`,
      },
      rawResponse: {
        id: runId,
      },
    };
  }

  async estimateCost(req: {
    model: string;
    inputTokensApprox: number;
    outputTokensApprox: number;
    cachedInputTokensApprox?: number;
  }): Promise<SubstrateCostQuote> {
    const isCached = req.cachedInputTokensApprox && req.cachedInputTokensApprox > 0;
    const baseInput = req.inputTokensApprox * 0;
    const baseOut = req.outputTokensApprox * 0;
    const cached = isCached ? req.cachedInputTokensApprox! * 0 : 0;
    return {
      inputCostUsdPerMTok: baseInput / 1_000_000,
      outputCostUsdPerMTok: baseOut / 1_000_000,
      cachedInputCostUsdPerMTok: cached / 1_000_000,
      currency: "USD",
    };
  }

  async getUsage(runId: string): Promise<SubstrateUsage | null> {
    const usage = this.usages.get(runId);
    if (!usage) return null;
    return cloneUsage(usage);
  }
}
