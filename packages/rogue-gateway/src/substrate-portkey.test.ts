import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { PortkeyCompatibleSubstrate } from "./substrate-portkey.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("error", reject);
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

describe("PortkeyCompatibleSubstrate", () => {
  it("reads env-driven Portkey/OpenAI-compatible settings and forwards the pi-dedicated model through the gateway", async () => {
    const requests: Array<{ method?: string; path: string; headers: Record<string, string | string[] | undefined>; body?: string }> = [];

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBody(req);
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

      if (req.method === "GET" && url.pathname === "/models") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, { data: [{ id: "openai-codex/gpt-5.5", object: "model" }] });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        writeJson(res, 200, {
          id: "chatcmpl-compat-1",
          model: "openai-codex/gpt-5.5",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        });
        return;
      }

      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected ${req.method} ${url.pathname}` }));
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

    const prev = {
      PORTKEY_BASE_URL: process.env.PORTKEY_BASE_URL,
      PORTKEY_API_KEY: process.env.PORTKEY_API_KEY,
      PORTKEY_AUTH_HEADER: process.env.PORTKEY_AUTH_HEADER,
      PORTKEY_EXTRA_HEADERS_JSON: process.env.PORTKEY_EXTRA_HEADERS_JSON,
    };

    process.env.PORTKEY_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PORTKEY_API_KEY = "pk_test_123";
    process.env.PORTKEY_AUTH_HEADER = "x-portkey-api-key";
    process.env.PORTKEY_EXTRA_HEADERS_JSON = JSON.stringify({ "x-portkey-workspace-id": "ws_test" });

    try {
      const substrate = PortkeyCompatibleSubstrate.fromEnv();
      const models = await substrate.listModels();
      expect(models).toEqual([{ id: "openai-codex/gpt-5.5", object: "model" }]);

      const chat = await substrate.callChat({
        model: "pi-dedicated",
        messages: [{ role: "user", content: "measure token modes" }],
        metadata: { modelMode: "lookup_compress" },
      });

      expect(chat.ok).toBe(true);
      expect(chat.model).toBe("openai-codex/gpt-5.5");
      expect(chat.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });

      expect(requests.some((entry) => entry.path === "/v1/models")).toBe(true);
      expect(requests.some((entry) => entry.path === "/v1/chat/completions")).toBe(true);
      const firstChat = requests.find((entry) => entry.path === "/v1/chat/completions");
      expect(firstChat?.headers["x-portkey-api-key"]).toBe("pk_test_123");
      expect(firstChat?.headers["x-portkey-workspace-id"]).toBe("ws_test");
      expect(firstChat?.body).toContain('"model":"pi-dedicated"');
    } finally {
      server.close();
      for (const [key, value] of Object.entries(prev)) {
        if (typeof value === "undefined") {
          delete process.env[key as keyof NodeJS.ProcessEnv];
        } else {
          process.env[key as keyof NodeJS.ProcessEnv] = value;
        }
      }
    }
  });
});
