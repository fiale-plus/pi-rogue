import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { SubstrateMock } from "./substrate-mock.js";
import { createRoutedGatewaySubstrate, createRoutedPortkeyGatewaySubstrate, loadPiRogueRouterConfig, resolveRouterModelTarget, type PiRogueRouterConfig } from "./model-routing.js";

const fixtureRouterConfig: PiRogueRouterConfig = {
  activeProfile: "fusion-smart",
  profiles: {
    "fusion-smart": {
      worker: "fusion/opencode-go-qwen-deepseek-gpt55",
      smart: "fusion/opencode-go-qwen-deepseek-gpt55",
      teacher: "fusion/opencode-go-qwen-deepseek-gpt55",
      reviewer: "fusion/opencode-go-qwen-deepseek-gpt55",
      explore: "fusion/opencode-go-qwen-deepseek-gpt55",
      debug_diagnose: "fusion/opencode-go-qwen-deepseek-gpt55",
      review: "fusion/opencode-go-qwen-deepseek-gpt55",
      verify: "fusion/opencode-go-qwen-deepseek-gpt55",
    },
    "local-smart": {
      worker: "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-ud-q4-k-m",
      smart: "openai-codex/gpt-5.5",
      teacher: "openai-codex/gpt-5.5",
      reviewer: "openai-codex/gpt-5.5",
      explore: "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-ud-q4-k-m",
      debug_diagnose: "openai-codex/gpt-5.5",
      review: "openai-codex/gpt-5.5",
      verify: "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-ud-q4-k-m",
    },
  },
};

describe("model routing", () => {
  it("maps the active Pi profile to the upstream GPT target from config", () => {
    const selected = resolveRouterModelTarget(fixtureRouterConfig, {
      profile: "local-smart",
      role: "smart",
      requestedModel: "pi-dedicated",
    });

    expect(selected).toMatchObject({
      profile: "local-smart",
      role: "smart",
      requestedModel: "pi-dedicated",
      upstreamModel: "openai-codex/gpt-5.5",
      source: "profile-role",
    });
  });

  it("forwards chat calls to the configured upstream GPT model target", async () => {
    const upstream = new SubstrateMock("substrate-mock", {
      models: [{ id: "openai-codex/gpt-5.5", object: "model" }],
    });

    const routed = await createRoutedGatewaySubstrate(upstream, {
      routerConfig: fixtureRouterConfig,
      profile: "local-smart",
      role: "smart",
    });

    const response = await routed.callChat({
      model: "pi-dedicated",
      messages: [{ role: "user", content: "measure token modes" }],
    });

    expect(response.ok).toBe(true);
    expect(response.model).toBe("openai-codex/gpt-5.5");
    expect(response.content).toMatchObject({ role: "assistant", content: "mock:openai-codex/gpt-5.5" });
  });

  it("reads router config from the explicit env-config path", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "rogue-router-config-"));
    const rootConfigPath = join(workdir, "config.json");
    const routerConfigPath = join(workdir, "router.config.json");

    writeFileSync(rootConfigPath, JSON.stringify({ router: { config: routerConfigPath } }, null, 2));
    writeFileSync(routerConfigPath, JSON.stringify(fixtureRouterConfig, null, 2));

    const prevRoot = process.env.PI_ROGUE_CONFIG_PATH;
    const prevRouter = process.env.PI_ROGUE_ROUTER_CONFIG_PATH;
    process.env.PI_ROGUE_CONFIG_PATH = rootConfigPath;
    process.env.PI_ROGUE_ROUTER_CONFIG_PATH = routerConfigPath;

    try {
      const loaded = await loadPiRogueRouterConfig();
      expect(loaded.activeProfile).toBe("fusion-smart");
      expect(loaded.profiles["local-smart"]?.smart).toBe("openai-codex/gpt-5.5");
    } finally {
      if (typeof prevRoot === "undefined") {
        delete process.env.PI_ROGUE_CONFIG_PATH;
      } else {
        process.env.PI_ROGUE_CONFIG_PATH = prevRoot;
      }

      if (typeof prevRouter === "undefined") {
        delete process.env.PI_ROGUE_ROUTER_CONFIG_PATH;
      } else {
        process.env.PI_ROGUE_ROUTER_CONFIG_PATH = prevRouter;
      }

      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("creates an env-driven Portkey-compatible routed gateway and maps pi-dedicated to the configured GPT model", async () => {
    const requests: Array<{ method?: string; path: string; body?: string }> = [];

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("error", reject);
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      requests.push({ method: req.method, path: url.pathname, body });

      if (req.method === "GET" && url.pathname === "/models") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "openai-codex/gpt-5.5", object: "model" }] }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-compat-1",
          model: "openai-codex/gpt-5.5",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }));
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

    const rootWorkdir = mkdtempSync(join(tmpdir(), "rogue-router-config-"));
    const rootConfigPath = join(rootWorkdir, "config.json");
    const routerConfigPath = join(rootWorkdir, "router.config.json");
    writeFileSync(rootConfigPath, JSON.stringify({ router: { config: routerConfigPath } }, null, 2));
    writeFileSync(routerConfigPath, JSON.stringify(fixtureRouterConfig, null, 2));

    const prevRoot = process.env.PI_ROGUE_CONFIG_PATH;
    const prevRouter = process.env.PI_ROGUE_ROUTER_CONFIG_PATH;
    process.env.PI_ROGUE_CONFIG_PATH = rootConfigPath;
    process.env.PI_ROGUE_ROUTER_CONFIG_PATH = routerConfigPath;

    try {
      const routed = await createRoutedPortkeyGatewaySubstrate({ profile: "local-smart", role: "smart" });
      const response = await routed.callChat({
        model: "pi-dedicated",
        messages: [{ role: "user", content: "measure token modes" }],
      });

      expect(response.ok).toBe(true);
      expect(response.model).toBe("openai-codex/gpt-5.5");
      expect(requests.some((entry) => entry.path === "/v1/chat/completions" && entry.body?.includes('"model":"openai-codex/gpt-5.5"'))).toBe(true);
    } finally {
      server.close();

      if (typeof prevRoot === "undefined") {
        delete process.env.PI_ROGUE_CONFIG_PATH;
      } else {
        process.env.PI_ROGUE_CONFIG_PATH = prevRoot;
      }

      if (typeof prevRouter === "undefined") {
        delete process.env.PI_ROGUE_ROUTER_CONFIG_PATH;
      } else {
        process.env.PI_ROGUE_ROUTER_CONFIG_PATH = prevRouter;
      }

      for (const [key, value] of Object.entries(prev)) {
        if (typeof value === "undefined") {
          delete process.env[key as keyof NodeJS.ProcessEnv];
        } else {
          process.env[key as keyof NodeJS.ProcessEnv] = value;
        }
      }

      rmSync(rootWorkdir, { recursive: true, force: true });
    }
  });
});
