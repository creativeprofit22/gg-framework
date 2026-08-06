import { describe, expect, it } from "vitest";
import { localWireModelId, stream } from "./stream.js";
import { GGAIError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import type { StreamOptions } from "./types.js";

describe("localWireModelId", () => {
  it("strips the endpoint routing prefix so the server sees its own id", () => {
    expect(localWireModelId("local/ollama/qwen3-coder:30b")).toBe("qwen3-coder:30b");
    // Raw ids can contain slashes (vLLM serves HF repo ids).
    expect(localWireModelId("local/vllm/Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
  });

  it("leaves non-local ids untouched", () => {
    expect(localWireModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(localWireModelId("qwen/qwen3.6-plus")).toBe("qwen/qwen3.6-plus");
  });
});

describe("local provider", () => {
  it("refuses to stream without an endpoint instead of guessing a port", () => {
    expect(() =>
      stream({
        provider: "local",
        model: "local/ollama/qwen3-coder:30b",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "local",
      }),
    ).toThrow(GGAIError);
  });
});

describe("provider wire boundary", () => {
  it("strips provenance without cloning unrelated messages", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    const plain = { role: "system" as const, content: "system" };
    const tagged = {
      role: "user" as const,
      content: "hello",
      provenance: {
        source: "human" as const,
        kind: "prompt" as const,
        visibility: "transcript" as const,
      },
    };

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [plain, tagged],
        }),
      ).toThrow(sentinel);
      expect(captured?.messages[0]).toBe(plain);
      expect(captured?.messages[1]).toEqual({ role: "user", content: "hello" });
      expect(captured?.messages[1]).not.toHaveProperty("provenance");
      expect(tagged.provenance.source).toBe("human");
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });
});
