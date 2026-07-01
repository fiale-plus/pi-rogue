import { defaultAssetRegistry } from "./default-assets.js";
import { createRoutedPortkeyGatewaySubstrate, loadPiRogueRouterConfig, resolveRouterModelTarget, PI_DEDICATED_MODEL_ALIAS, type PiRogueRouterConfig } from "./model-routing.js";
import { quoteRoute } from "./planner.js";
import type { AssetRegistry, QuoteRequest, QuoteResult } from "./types.js";
import type { GatewaySubstrate, SubstrateChatResult } from "./substrate.js";

export type MeasurementMode = "raw_forward" | "typed_lens" | "lookup_compress";

export interface PiDedicatedModeMeasurement {
  mode: MeasurementMode;
  request: QuoteRequest;
  quote: QuoteResult;
  resolvedModel: string;
  chat: SubstrateChatResult;
}

export interface PiDedicatedMeasurementReport {
  profile: string;
  role: string;
  requestedModel: string;
  upstreamModel: string;
  modes: PiDedicatedModeMeasurement[];
}

export interface MeasurePiDedicatedModesOptions {
  routerConfig?: PiRogueRouterConfig;
  routerConfigPath?: string;
  profile?: string;
  role?: string;
  request: QuoteRequest;
  registry?: AssetRegistry;
  substrate?: GatewaySubstrate;
  env?: NodeJS.ProcessEnv;
}

function modeRequest(request: QuoteRequest, mode: MeasurementMode): QuoteRequest {
  switch (mode) {
    case "raw_forward":
      return {
        ...request,
        contextPolicy: "raw_forward",
        forwardedInputTokensApprox: request.rawInputTokensApprox,
      };
    case "typed_lens":
      return {
        ...request,
        contextPolicy: "typed_lens",
      };
    case "lookup_compress":
      return {
        ...request,
        contextPolicy: "typed_lens",
        forwardedInputTokensApprox: Math.max(1, Math.floor(request.forwardedInputTokensApprox * 0.5)),
      };
  }
}

function modeMessages(request: QuoteRequest, mode: MeasurementMode): unknown[] {
  const raw = Math.max(1, Math.floor(request.rawInputTokensApprox));
  const forwarded = Math.max(1, Math.floor(request.forwardedInputTokensApprox));
  const compressed = Math.max(1, Math.floor(forwarded * 0.5));
  const rawPayload = "x".repeat(Math.min(2048, raw));
  const forwardedPayload = "x".repeat(Math.min(1024, forwarded));
  const compressedPayload = "x".repeat(Math.min(512, compressed));

  switch (mode) {
    case "raw_forward":
      return [
        { role: "system", content: "raw-forward measurement" },
        { role: "assistant", content: `carried-context:${rawPayload}` },
        { role: "user", content: "measure pi-dedicated" },
      ];
    case "typed_lens":
      return [
        { role: "system", content: "typed-lens measurement" },
        { role: "user", content: `lens:${forwardedPayload}` },
      ];
    case "lookup_compress":
      return [
        { role: "system", content: "lookup-compress measurement" },
        { role: "user", content: "lookup context" },
        { role: "assistant", content: `compressed:${compressedPayload}` },
        { role: "user", content: "measure pi-dedicated" },
      ];
  }
}

export async function measurePiDedicatedModes(
  options: MeasurePiDedicatedModesOptions,
): Promise<PiDedicatedMeasurementReport> {
  const routerConfig = options.routerConfig ?? (await loadPiRogueRouterConfig(options.routerConfigPath));
  const resolvedTarget = resolveRouterModelTarget(routerConfig, {
    profile: options.profile,
    role: options.role,
    requestedModel: PI_DEDICATED_MODEL_ALIAS,
  });
  const registry = options.registry ?? defaultAssetRegistry;
  const substrate =
    options.substrate ??
    (await createRoutedPortkeyGatewaySubstrate({
      routerConfig,
      routerConfigPath: options.routerConfigPath,
      profile: options.profile,
      role: options.role,
      env: options.env,
    }));

  const modes: MeasurementMode[] = ["raw_forward", "typed_lens", "lookup_compress"];
  return {
    profile: resolvedTarget.profile,
    role: resolvedTarget.role,
    requestedModel: PI_DEDICATED_MODEL_ALIAS,
    upstreamModel: resolvedTarget.upstreamModel,
    modes: await Promise.all(modes.map(async (mode) => {
      const request = modeRequest(options.request, mode);
      const quote = quoteRoute({ request, registry });
      const chat = await substrate.callChat({
        model: PI_DEDICATED_MODEL_ALIAS,
        messages: modeMessages(options.request, mode),
        metadata: {
          measurementMode: mode,
          requestedModel: PI_DEDICATED_MODEL_ALIAS,
          routedUpstreamModel: resolvedTarget.upstreamModel,
        },
      });
      return {
        mode,
        request,
        quote,
        resolvedModel: resolvedTarget.upstreamModel,
        chat,
      };
    })),
  };
}
