import { OpenAICompatibleSubstrate, type OpenAICompatibleSubstrateOptions } from "./substrate-openai-compatible.js";

export interface PortkeyCompatibleSubstrateOptions extends Omit<OpenAICompatibleSubstrateOptions, "baseUrl" | "apiKey" | "authHeaderName" | "authScheme" | "defaultHeaders"> {
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  apiKey?: string;
  authHeaderName?: string;
  authScheme?: string;
  defaultHeaders?: Record<string, string>;
}

function parseHeadersJson(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, val]) =>
        typeof val === "string" ? [[key, val]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function resolvePortkeyCompatibleOptions(
  options: PortkeyCompatibleSubstrateOptions = {},
): OpenAICompatibleSubstrateOptions {
  const env = options.env ?? process.env;
  const baseUrl =
    options.baseUrl ??
    env.PORTKEY_BASE_URL?.trim() ??
    env.OPENAI_COMPATIBLE_BASE_URL?.trim() ??
    env.OPENAI_BASE_URL?.trim() ??
    env.OPENAI_API_BASE?.trim() ??
    "http://127.0.0.1:8000/v1";

  const apiKey = options.apiKey ?? env.PORTKEY_API_KEY?.trim() ?? env.OPENAI_API_KEY?.trim();
  const authHeaderName = options.authHeaderName ?? env.PORTKEY_AUTH_HEADER?.trim() ?? env.OPENAI_AUTH_HEADER?.trim() ?? "Authorization";
  const authScheme = options.authScheme ?? env.PORTKEY_AUTH_SCHEME?.trim() ?? env.OPENAI_AUTH_SCHEME?.trim() ?? "Bearer";
  const defaultHeaders = {
    ...parseHeadersJson(env.PORTKEY_EXTRA_HEADERS_JSON),
    ...parseHeadersJson(env.OPENAI_EXTRA_HEADERS_JSON),
    ...(options.defaultHeaders ?? {}),
  };

  return {
    id: options.id ?? "substrate-portkey-compatible",
    baseUrl,
    apiKey,
    authHeaderName,
    authScheme,
    defaultHeaders,
    timeoutMs: options.timeoutMs,
  };
}

export class PortkeyCompatibleSubstrate extends OpenAICompatibleSubstrate {
  constructor(options: PortkeyCompatibleSubstrateOptions = {}) {
    super(resolvePortkeyCompatibleOptions(options));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PortkeyCompatibleSubstrate {
    return new PortkeyCompatibleSubstrate({ env });
  }
}
