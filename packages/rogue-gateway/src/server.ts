import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendEvent } from "./events.js";
import { defaultAssetRegistry } from "./default-assets.js";
import type { AssetRegistry, QuoteRequest, QuoteResult } from "./types.js";
import { quoteRoute } from "./planner.js";

export const DEFAULT_GATEWAY_EVENT_LOG = ".pi/rogue-gateway-spike/events.jsonl";

export interface GatewayServerOptions {
  port?: number;
  registry?: AssetRegistry;
  eventLogPath?: string;
  now?: () => string;
}

interface GatewayServerHandle {
  close: () => Promise<void>;
  port: number;
  eventsPath: string;
}

interface QuoteRequestEnvelope {
  runId?: string;
  request?: QuoteRequest;
}

function parseRequestBody(text: string): unknown {
  if (!text) return {};
  return JSON.parse(text);
}

function parseJsonBodySafely(text: string): { parsed: unknown; parseError: string | null } {
  try {
    return { parsed: parseRequestBody(text), parseError: null };
  } catch {
    return {
      parsed: null,
      parseError: "invalid json",
    };
  }
}

function isQuoteRequest(value: unknown): value is QuoteRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const contextPolicy = candidate.contextPolicy;
  const candidateAssets = candidate.candidateAssets;

  if (typeof candidate.profile !== "string") return false;
  if (typeof candidate.taskKind !== "string") return false;
  if (typeof candidate.rawInputTokensApprox !== "number" || !Number.isFinite(candidate.rawInputTokensApprox)) return false;
  if (typeof candidate.forwardedInputTokensApprox !== "number" || !Number.isFinite(candidate.forwardedInputTokensApprox)) return false;
  if (typeof candidate.expectedOutputTokensApprox !== "number" || !Number.isFinite(candidate.expectedOutputTokensApprox)) return false;
  if (typeof contextPolicy !== "string") return false;
  if (!Array.isArray(candidateAssets) || candidateAssets.some((asset) => typeof asset !== "string")) return false;

  return true;
}

function isQuoteRequestEnvelope(value: unknown): value is QuoteRequestEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if ("request" in candidate && candidate.request === undefined) return false;
  if (typeof candidate.runId !== "undefined" && typeof candidate.runId !== "string") return false;
  if (!Object.hasOwn(candidate, "request")) return false;
  if (!isQuoteRequest(candidate.request)) return false;
  return true;
}

function safeResponsePayload(result: QuoteResult, runId: string) {
  return {
    runId,
    selected: result.selected,
    alternatives: result.alternatives,
    savings: result.savings,
    guards: result.guards,
  };
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of req) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
}

export async function startGatewayServer(options: GatewayServerOptions = {}): Promise<GatewayServerHandle> {
  const eventLogPath = options.eventLogPath ?? DEFAULT_GATEWAY_EVENT_LOG;
  const port = options.port ?? 0;
  const registry = options.registry ?? defaultAssetRegistry;

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/rogue/economics/quote") {
      const body = await readBody(req);
      const { parsed, parseError } = parseJsonBodySafely(body);

      if (parseError) {
        sendJson(res, 400, { error: parseError });
        return;
      }

      try {
        const request = isQuoteRequestEnvelope(parsed)
          ? parsed.request
          : isQuoteRequest(parsed)
            ? parsed
            : null;

        if (!request) {
          sendJson(res, 400, { error: "invalid quote request" });
          return;
        }

        const runId = isQuoteRequestEnvelope(parsed) && typeof parsed.runId === "string"
          ? parsed.runId
          : randomUUID();

        appendEvent(eventLogPath, {
          runId,
          type: "request_received",
          data: {
            method: req.method ?? "POST",
            route: req.url ?? "/rogue/economics/quote",
            requestPath: "/rogue/economics/quote",
          },
        });

        const result = quoteRoute({
          request,
          registry,
          now: options.now,
        });

        appendEvent(eventLogPath, {
          runId,
          type: "artifact_detected",
          data: {
            profile: String(request.profile),
            candidateAssets: request.candidateAssets,
            contextPolicy: request.contextPolicy,
          },
        });

        appendEvent(eventLogPath, {
          runId,
          type: "context_lens_created",
          data: {
            rawInputTokensApprox: request.rawInputTokensApprox,
            forwardedInputTokensApprox: request.forwardedInputTokensApprox,
            contextPolicy: request.contextPolicy,
          },
        });

        appendEvent(eventLogPath, {
          runId,
          type: "profile_resolved",
          data: {
            profile: String(request.profile),
            candidateAssets: request.candidateAssets,
          },
        });

        appendEvent(eventLogPath, {
          runId,
          type: "route_planned",
          data: {
            selected: result.selected,
            alternatives: result.alternatives.length,
          },
        });

        appendEvent(eventLogPath, {
          runId,
          type: "economics_quoted",
          data: {
            estimatedSavings: result.savings,
            selectedRoute: result.selected.route,
            selectedAsset: result.selected.asset,
          },
        });

        appendEvent(eventLogPath, {
          runId,
          type: "response_returned",
          data: {
            status: 200,
            alternatives: result.alternatives.length,
          },
        });

        sendJson(res, 200, safeResponsePayload(result, runId));
        return;
      } catch (error) {
        const failure = error instanceof Error ? error.message : "quote failed";
        const errorRunId = randomUUID();
        appendEvent(eventLogPath, {
          runId: errorRunId,
          type: "response_returned",
          data: {
            status: 500,
            error: failure,
          },
        });
        sendJson(res, 500, { error: failure });
        return;
      }
    }

    res.statusCode = 404;
    res.end("not-found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    port: actualPort,
    eventsPath: eventLogPath,
  };
}
