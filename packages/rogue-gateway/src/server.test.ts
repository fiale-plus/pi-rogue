import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "./events.js";
import { DEFAULT_GATEWAY_EVENT_LOG, startGatewayServer } from "./server.js";

describe("rogue gateway server", () => {
  it("serves /rogue/economics/quote and emits expected decision events", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "rogue-gateway-"));
    const eventLogPath = join(workdir, ".pi", "rogue-gateway-spike", "events.jsonl");
    const server = await startGatewayServer({
      port: 0,
      eventLogPath,
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/rogue/economics/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "local-first-economy",
        taskKind: "coding_debug",
        rawInputTokensApprox: 82_000,
        forwardedInputTokensApprox: 2_400,
        expectedOutputTokensApprox: 900,
        contextPolicy: "typed_lens",
        candidateAssets: ["local.qwen35", "remote.cheap", "remote.premium", "subscription.smart"],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.selected.route).toBe("local_first_typed_lens");
    expect(payload.selected.asset).toBe("local.qwen35");

    const events = readEvents(eventLogPath);
    const eventsSet = new Set(events.map((row) => row.type));
    expect(eventsSet).toContain("request_received");
    expect(eventsSet).toContain("artifact_detected");
    expect(eventsSet).toContain("context_lens_created");
    expect(eventsSet).toContain("economics_quoted");
    expect(eventsSet).toContain("route_planned");
    expect(eventsSet).toContain("profile_resolved");
    expect(eventsSet).toContain("response_returned");

    const recorded = readFileSync(eventLogPath, "utf8");
    expect(recorded.length).toBeGreaterThan(10);

    await server.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  it("exports default health endpoint", async () => {
    const server = await startGatewayServer({
      port: 0,
      eventLogPath: DEFAULT_GATEWAY_EVENT_LOG,
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await server.close();
  });

  it("rejects malformed quote payload", async () => {
    const server = await startGatewayServer({
      port: 0,
      eventLogPath: "/tmp/nonexistent-events.jsonl",
    });

    const bad = await fetch(`http://127.0.0.1:${server.port}/rogue/economics/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "local-first-economy" }),
    });

    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid quote request" });
    await server.close();
  });

  it("rejects invalid JSON body", async () => {
    const server = await startGatewayServer({
      port: 0,
      eventLogPath: "/tmp/nonexistent-events.jsonl",
    });

    const bad = await fetch(`http://127.0.0.1:${server.port}/rogue/economics/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ invalid-json",
    });

    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid json" });
    await server.close();
  });
});
