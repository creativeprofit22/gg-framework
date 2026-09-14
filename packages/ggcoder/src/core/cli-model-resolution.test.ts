import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getDefaultModel } from "./model-registry.js";
import {
  resolveInteractiveCliModel,
  resolveRpcModel,
  resolveSavedCliModel,
} from "./cli-model-resolution.js";

describe("CLI model resolution", () => {
  it("uses the provider registry when no model is saved", () => {
    expect(resolveSavedCliModel("openai", undefined)).toBe(getDefaultModel("openai").id);
  });

  it("rejects a stale saved GPT-5.5 selection", () => {
    expect(resolveSavedCliModel("openai", "gpt-5.5")).toBe(getDefaultModel("openai").id);
  });

  it("rejects a saved model from another provider", () => {
    expect(resolveSavedCliModel("anthropic", getDefaultModel("openai").id)).toBe(
      getDefaultModel("anthropic").id,
    );
  });

  it("gives a valid explicit interactive model precedence over saved settings", () => {
    expect(resolveInteractiveCliModel("anthropic", "claude-opus-5", "claude-sonnet-5")).toBe(
      "claude-opus-5",
    );
  });

  it("rejects invalid explicit interactive models instead of silently defaulting", () => {
    expect(() => resolveInteractiveCliModel("openai", "gpt-5.5", "gpt-6-astra")).toThrow(
      'Unknown --model value "gpt-5.5".',
    );
  });

  it("uses Astra for RPC OpenAI defaults while preserving explicit transport models", () => {
    expect(resolveRpcModel("openai", undefined)).toBe("gpt-6-astra");
    expect(resolveRpcModel("openai", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("shows Astra rather than GPT-5.5 in CLI model guidance", () => {
    const cliSource = fs.readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    expect(cliSource).toContain("Model to use (e.g. claude-sonnet-5, gpt-6-astra)");
    expect(cliSource).not.toContain("Model to use (e.g. claude-sonnet-5, gpt-5.5)");
  });
});
