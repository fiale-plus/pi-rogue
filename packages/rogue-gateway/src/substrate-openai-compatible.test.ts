import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { OpenAICompatibleSubstrate } from "./substrate-openai-compatible.js";

type BodyData = Record<string, unknown>;

function readBody(req: IncomingMessage): Promise<BodyData | string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("error", reject);
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }

      const payload = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(payload) as BodyData);
      } catch {
        resolve(payload);
      }
    });
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

describe("OpenAICompatibleSubstrate", () => {
  it("falls back to /v1-compatible paths used by Portkey-like gateways", async () => {
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      const reqBody = await readBody(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(`${req.method} ${url.pathname}`);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, {
          data: [{ id: "remote.gpt-4o-mini", object: "model" }],
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/models") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (reqBody && typeof reqBody === "object" ? reqBody : {}) as {
          model?: string;
        };

        writeJson(res, 200, {
          id: "chatcmpl-1",
          model: body.model,
          object: "chat.completion",
          choices: [{ message: { content: "ok", role: "assistant" } }],
          usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/context/compress") {
        writeJson(res, 200, { compressed: true, tokenCount: 17 });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/context/clip") {
        writeJson(res, 200, { clipped: true, clippedLength: 32 });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/context/lookup") {
        writeJson(res, 200, {
          lookup: {
            hit: true,
            source: "mock-portkey",
          },
        });
        return;
      }

      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected ${req.method} ${url.pathname}` }));
    });

    try {
      const port = await new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as AddressInfo).port);
        }),
      );

      const substrate = new OpenAICompatibleSubstrate({
        baseUrl: `http://127.0.0.1:${port}`,
      });

      const models = await substrate.listModels();
      expect(models).toEqual([{ id: "remote.gpt-4o-mini", object: "model" }]);

      const chat = await substrate.callChat({
        model: "remote.gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(chat.ok).toBe(true);
      expect(chat.status).toBe(200);
      expect(chat.model).toBe("remote.gpt-4o-mini");
      expect(chat.usage).toEqual({ prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 });

      const compress = await fetch(`http://127.0.0.1:${port}/v1/context/compress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "This is very long user context payload." }),
      });
      const compressBody = await compress.json();
      expect(compressBody).toMatchObject({ compressed: true, tokenCount: 17 });

      const clip = await fetch(`http://127.0.0.1:${port}/v1/context/clip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "payload", limitTokens: 10 }),
      });
      const clipBody = await clip.json();
      expect(clipBody).toMatchObject({ clipped: true, clippedLength: 32 });

      const lookup = await fetch(`http://127.0.0.1:${port}/v1/context/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "recent contract clause" }),
      });
      const lookupBody = await lookup.json();
      expect(lookupBody).toMatchObject({ lookup: { hit: true, source: "mock-portkey" } });

      expect(requests).toContain("GET /models");
      expect(requests).toContain("GET /v1/models");
      expect(requests).toContain("POST /chat/completions");
      expect(requests).toContain("POST /v1/chat/completions");
      expect(requests).toContain("POST /v1/context/compress");
      expect(requests).toContain("POST /v1/context/clip");
      expect(requests).toContain("POST /v1/context/lookup");
    } finally {
      server.close();
    }
  });
});
