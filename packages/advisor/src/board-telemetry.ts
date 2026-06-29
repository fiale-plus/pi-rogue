import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { featureDir } from "./internal.js";

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function telemetrySeed(ctx: any): string | undefined {
  const sessionFile = safeText(ctx?.sessionManager?.getSessionFile?.());
  const cwd = safeText(ctx?.cwd) ? resolve(String(ctx.cwd)) : undefined;
  const sessionId = safeText(ctx?.session?.id);
  const envSessionId = safeText(process.env.PI_ROGUE_SESSION_ID);
  const safeSessionId = sessionId && sessionId !== "session" ? sessionId : undefined;
  if (!sessionFile && !cwd && !safeSessionId && !envSessionId) return undefined;
  return JSON.stringify({
    sessionFile: sessionFile ? resolve(sessionFile) : undefined,
    cwd,
    sessionId: safeSessionId,
    envSessionId,
  });
}

export function resolveBoardTelemetryScope(ctx: any): string | undefined {
  const seed = telemetrySeed(ctx);
  if (!seed) return undefined;
  return `board-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function boardTelemetryDir(ctx: any): string | undefined {
  const scope = resolveBoardTelemetryScope(ctx);
  return scope ? join(featureDir("advisor"), "board-sessions", scope) : undefined;
}

export function boardTelemetryPath(ctx: any, filename: string): string | undefined {
  const dir = boardTelemetryDir(ctx);
  return dir ? join(dir, filename) : undefined;
}
