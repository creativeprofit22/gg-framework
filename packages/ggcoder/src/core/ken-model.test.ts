import { describe, it, expect } from "vitest";
import { validateKenModelPref, effectiveKenModel, type KenModelPref } from "./ken-model.js";

const REGISTRY = new Set(["claude-opus-5-5", "gpt-5.5", "kimi-k2.7-code"]);
const CONNECTED = new Set(["anthropic", "openai"]);

const opts = {
  modelExists: (id: string) => REGISTRY.has(id),
  providerConnected: (p: string) => CONNECTED.has(p),
};

describe("validateKenModelPref", () => {
  it("passes a valid pref through", () => {
    const pref: KenModelPref = { provider: "openai", model: "gpt-5.5" };
    expect(validateKenModelPref(pref, opts)).toEqual(pref);
  });

  it("nulls when the model left the registry (stale persisted pin)", () => {
    expect(validateKenModelPref({ provider: "openai", model: "gpt-4-turbo" }, opts)).toBeNull();
  });

  it("nulls when the provider is no longer connected (logged out)", () => {
    expect(
      validateKenModelPref({ provider: "moonshot", model: "kimi-k2.7-code" }, opts),
    ).toBeNull();
  });

  it("nulls absent / malformed prefs", () => {
    expect(validateKenModelPref(null, opts)).toBeNull();
    expect(validateKenModelPref(undefined, opts)).toBeNull();
    expect(validateKenModelPref({ provider: "openai", model: "" }, opts)).toBeNull();
    expect(
      validateKenModelPref({ provider: "" as KenModelPref["provider"], model: "gpt-5.5" }, opts),
    ).toBeNull();
  });
});

describe("effectiveKenModel", () => {
  const build = { provider: "anthropic" as const, model: "claude-opus-5-5" };

  it("follows the build session when no override is set", () => {
    expect(effectiveKenModel(null, build)).toEqual({
      kenProvider: "anthropic",
      kenModel: "claude-opus-5-5",
      kenModelOverride: false,
    });
  });

  it("uses the pin when set, ignoring the build model", () => {
    expect(effectiveKenModel({ provider: "openai", model: "gpt-5.5" }, build)).toEqual({
      kenProvider: "openai",
      kenModel: "gpt-5.5",
      kenModelOverride: true,
    });
  });

  it("pin identical to the build model still reports override=true (it survives GG switches)", () => {
    expect(effectiveKenModel({ provider: "anthropic", model: "claude-opus-5-5" }, build)).toEqual({
      kenProvider: "anthropic",
      kenModel: "claude-opus-5-5",
      kenModelOverride: true,
    });
  });
});
