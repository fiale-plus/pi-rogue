import { describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai";
import { scanShellCommand } from "@fiale-plus/pi-core";
import { llmReview } from "./llm-review.js";

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    completeSimple: vi.fn(),
  };
});

function mkCtx(available: Array<{ id: string; provider?: string; input?: string[] }> = [], prefer?: { provider: string; model: string }) {
  const byFind = prefer ? {
    provider: prefer.provider,
    model: prefer.model,
  } : null;
  return {
    modelRegistry: {
      find: (provider: string, model: string) => {
        if (!byFind) return null;
        if (provider === byFind.provider && model === byFind.model) {
          return {
            id: `${provider}/${model}`,
            provider,
            input: ["text"],
          };
        }
        return null;
      },
      getAvailable: () => available,
      getApiKeyAndHeaders: async () => ({ apiKey: "k", headers: {} }),
    },
  } as any;
}

describe("llmReview", () => {
  it("uses configured model override when available", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: '{"verdict":"allow","reasoning":"trusted helper"}' }] });

    const ctx = mkCtx([
      { id: "provider/text-light", provider: "provider", input: ["text"] },
      { id: "provider/qwen2", provider: "provider", input: ["text"] },
    ], { provider: "provider", model: "qwen2" });

    const result = await llmReview(
      "echo hello",
      scanShellCommand("echo hello"),
      [],
      ctx,
      "provider/qwen2",
    );

    expect(result.verdict).toBe("allow");
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect((completeSimpleMock.mock.calls[0]?.[0] as { id?: string })?.id).toBe("provider/qwen2");
  });

  it("falls back to lightweight model automatically when no override", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: '{"verdict":"ask","reasoning":"needs confirmation"}' }] });

    const ctx = mkCtx([
      { id: "provider/regular", provider: "provider", input: ["text"] },
      { id: "provider/text-light", provider: "provider", input: ["text"] },
    ]);

    const result = await llmReview(
      "git checkout main",
      scanShellCommand("git checkout main"),
      [],
      ctx,
    );

    expect(result.verdict).toBe("ask");
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect((completeSimpleMock.mock.calls[0]?.[0] as { id?: string })?.id).toBe("provider/text-light");
  });

  it("falls back to local tiny review when llm model is local", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();

    const ctx = mkCtx([
      { id: "provider/primary", provider: "provider", input: ["text"] },
    ]);
    const result = await llmReview(
      "rm -rf /tmp/test",
      scanShellCommand("rm -rf /tmp/test"),
      [],
      ctx,
      "local",
    );

    expect(result.verdict).toBe("block");
    expect(completeSimpleMock).toHaveBeenCalledTimes(0);
  });

  it("falls back to heuristic when no model is available", async () => {
    const ctx = { modelRegistry: null } as any;
    const result = await llmReview(
      "rm -rf /tmp/test",
      scanShellCommand("rm -rf /tmp/test"),
      [],
      ctx,
    );

    expect(result.verdict).toBe("block");
  });

  it("local tiny review does not call provider for safe commands", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();

    const ctx = mkCtx([
      { id: "provider/text-light", provider: "provider", input: ["text"] },
    ]);

    const result = await llmReview(
      "echo hello",
      scanShellCommand("echo hello"),
      [],
      ctx,
      "tiny",
    );

    expect(result.verdict).toBe("allow");
    expect(completeSimpleMock).toHaveBeenCalledTimes(0);
  });

  it("falls back to heuristic when model output is not JSON", async () => {
    const completeSimpleMock = vi.mocked(completeSimple as any);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ content: [{ type: "text", text: "not valid json" }] });

    const ctx = mkCtx([
      { id: "provider/text-light", provider: "provider", input: ["text"] },
    ]);

    const result = await llmReview(
      "rm -rf /tmp/test",
      scanShellCommand("rm -rf /tmp/test"),
      [],
      ctx,
    );

    expect(result.verdict).toBe("block");
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
  });
});
