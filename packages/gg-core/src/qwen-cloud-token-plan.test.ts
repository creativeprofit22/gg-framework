import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { QWEN_CLOUD_MODEL_CAPABILITIES as aiCapabilities, type Provider } from "@kenkaiiii/gg-ai";
import {
  MODELS,
  getModel,
  getDefaultModel,
  getFastModel,
  getSummaryModel,
  getAuthStorageKeys,
} from "./model-registry.js";
import {
  getSupportedThinkingLevels,
  getNextThinkingLevel,
  clampThinkingLevel,
  resolveInitialThinkingLevel,
} from "./thinking-level.js";
import { stream, getQwenCloudCapability, type ThinkingLevel } from "@kenkaiiii/gg-ai";
import {
  getQwenCloudThinkingLabel,
  QWEN_CLOUD_API_MODEL_IDS,
  QWEN_CLOUD_CAPABILITY_SOURCES,
  type QwenCloudModelCapability,
  QWEN_CLOUD_DEFAULT_MODEL_ID,
  QWEN_CLOUD_FAST_MODEL_ID,
  QWEN_CLOUD_MODEL_CAPABILITIES,
  QWEN_CLOUD_SUMMARY_MODEL_ID,
  QWEN_CLOUD_TOKEN_PLAN_ENDPOINT,
  QWEN_CLOUD_TOKEN_PLAN_KEY_ENV,
  QWEN_CLOUD_TOKEN_PLAN_KEY_PREFIX,
  type QwenCloudConnectionResult,
  type QwenCloudConnectionStatus,
} from "./qwen-cloud-token-plan.js";

const expectedIds = [
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "glm-5.3",
  "glm-5.2",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731",
  "deepseek-v4.1-flash",
];

describe("Qwen Cloud Token Plan registry and policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("fails closed without explicit or dedicated runtime Token Plan auth", async () => {
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-sp-fake-generic");
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-sp-fake-generic");
    await expect(
      stream({ provider: "qwen-cloud", model: QWEN_CLOUD_DEFAULT_MODEL_ID, messages: [] }),
    ).rejects.toThrow("Qwen Cloud requires a valid Token Plan key.");
  });
  it("defines only the approved route and credential identity", () => {
    expect(QWEN_CLOUD_TOKEN_PLAN_ENDPOINT).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(QWEN_CLOUD_TOKEN_PLAN_KEY_ENV).toBe("QWEN_CLOUD_TOKEN_PLAN_KEY");
    expect(QWEN_CLOUD_TOKEN_PLAN_KEY_PREFIX).toBe("sk-sp-");
  });

  it("keeps all eleven exact wire IDs distinct from internal and registered identities", () => {
    expect(QWEN_CLOUD_API_MODEL_IDS).toEqual(expectedIds);
    expect(QWEN_CLOUD_MODEL_CAPABILITIES.map((m) => m.apiModelId)).toEqual(expectedIds);
    const ids = QWEN_CLOUD_MODEL_CAPABILITIES.map((m) => m.id);
    expect(ids).toEqual(expectedIds.map((id) => `qwen-cloud/${id}`));
    expect(new Set(ids).size).toBe(11);
    expect(MODELS.filter((m) => m.provider === "qwen-cloud").map((m) => m.id)).toEqual(ids);
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
    for (const capability of QWEN_CLOUD_MODEL_CAPABILITIES) {
      expect(getModel(capability.id)).toMatchObject({
        name: capability.name,
        provider: "qwen-cloud",
        modelIdentity: capability.apiModelId,
        contextWindow: capability.contextWindow,
        maxOutputTokens: capability.maxOutputTokens,
        supportsThinking: true,
        supportsImages: false,
        supportsVideo: false,
      });
      expect(getAuthStorageKeys("qwen-cloud", capability.id)).toEqual(["qwen-cloud"]);
      expect(getQwenCloudCapability(capability.apiModelId)).toBeUndefined();
    }
    expect(getDefaultModel("qwen-cloud").id).toBe(QWEN_CLOUD_DEFAULT_MODEL_ID);
    expect(getFastModel("qwen-cloud", "glm-5.3").id).toBe(QWEN_CLOUD_FAST_MODEL_ID);
    expect(getSummaryModel("qwen-cloud", "deepseek-v4-pro").id).toBe(QWEN_CLOUD_SUMMARY_MODEL_ID);
    expect(QWEN_CLOUD_DEFAULT_MODEL_ID).toBe("qwen-cloud/qwen3.8-max");
    expect(QWEN_CLOUD_FAST_MODEL_ID).toBe("qwen-cloud/qwen3.8-flash");
    expect(QWEN_CLOUD_SUMMARY_MODEL_ID).toBe(QWEN_CLOUD_FAST_MODEL_ID);
  });

  it("records conservative numeric limits and combined GLM output budgets", () => {
    expect(QWEN_CLOUD_MODEL_CAPABILITIES.map((m) => m.maxOutputTokens)).toEqual([
      128_000, 128_000, 64_000, 64_000, 64_000, 128_000, 131_000, 384_000, 384_000, 384_000,
      384_000,
    ]);
    for (const model of QWEN_CLOUD_MODEL_CAPABILITIES) {
      expect(model.provider).toBe("qwen-cloud");
      expect(model.contextWindow).toBe(1_000_000);
      expect(model.supportsImages).toBe(false);
      expect(model.sources.length).toBeGreaterThan(0);
      expect(model.outputLimitScope).toBe(
        model.apiModelId.startsWith("qwen") ? "answer" : "reasoning-and-answer",
      );
    }
  });

  it("reexports gg-ai policy with authoritative GLM evidence and typed provider registration", () => {
    expect(QWEN_CLOUD_MODEL_CAPABILITIES).toBe(aiCapabilities);
    expectTypeOf<QwenCloudModelCapability["maxOutputTokens"]>().toEqualTypeOf<number>();
    expectTypeOf<QwenCloudModelCapability["outputLimitScope"]>().toEqualTypeOf<
      "answer" | "reasoning-and-answer"
    >();
    expectTypeOf<Extract<Provider, "qwen-cloud">>().toEqualTypeOf<"qwen-cloud">();
    expect(QWEN_CLOUD_CAPABILITY_SOURCES.glm52Marketplace).toBe(
      "https://www.qwencloud.com/models/glm-5.2",
    );
    expect(QWEN_CLOUD_CAPABILITY_SOURCES.chat).toBe(
      "https://docs.qwencloud.com/api-reference/chat/openai-chat.md",
    );
    for (const model of QWEN_CLOUD_MODEL_CAPABILITIES.filter((m) =>
      m.apiModelId.startsWith("glm-"),
    )) {
      expect(model.sources).toContain("chat");
      if (model.apiModelId === "glm-5.2") expect(model.sources).toContain("glm52Marketplace");
    }
  });

  it("records real binary/effort/always-on controls without enabling budget conflicts", () => {
    expect(QWEN_CLOUD_MODEL_CAPABILITIES.map((m) => m.thinking.levels)).toEqual([
      ["off", "low", "medium", "xhigh"],
      ["off", "low", "medium", "xhigh"],
      ["off", "on"],
      ["off", "on"],
      ["off", "on"],
      ["low", "high", "max"],
      ["off", "high", "max"],
      ["off", "high", "max"],
      ["off", "low", "high", "max"],
      ["off", "low", "high", "max"],
      ["off", "low", "high", "max"],
    ]);
    for (const model of QWEN_CLOUD_MODEL_CAPABILITIES) {
      expect(model.thinkingBudgetPolicy).toBe("omit");
      expect(model.thinking.kind).toBe(
        model.thinking.levels.some((level) => level === "on") ? "binary" : "effort",
      );
    }
  });

  it("normalizes and cycles exactly the policy, including binary and always-on", () => {
    for (const model of QWEN_CLOUD_MODEL_CAPABILITIES) {
      const levels = getSupportedThinkingLevels("qwen-cloud", model.id);
      const alwaysOn = model.apiModelId === "glm-5.3";
      expect(levels).toEqual(
        model.thinking.kind === "binary"
          ? ["high"]
          : model.thinking.levels.filter((l) => l !== "off"),
      );
      expect(clampThinkingLevel("qwen-cloud", model.id, "ultra")).toBe(levels[0]);
      expect(resolveInitialThinkingLevel("qwen-cloud", model.id, false, "ultra")).toBe(
        alwaysOn ? "high" : undefined,
      );
      let current: ThinkingLevel | undefined;
      for (const level of levels) {
        current = getNextThinkingLevel("qwen-cloud", model.id, current);
        expect(current).toBe(level);
      }
      expect(getNextThinkingLevel("qwen-cloud", model.id, current)).toBe(
        alwaysOn ? "low" : undefined,
      );
      if (model.thinking.kind === "binary") {
        expect(getQwenCloudThinkingLabel(model.id, "high")).toBe("Thinking on");
        expect(getQwenCloudThinkingLabel(model.id, null)).toBe("Thinking off");
      }
    }
    expect(getSupportedThinkingLevels("qwen-cloud", "glm-5.3")).toEqual([]);
    expect(clampThinkingLevel("qwen-cloud", "qwen-cloud/unknown", "high")).toBeUndefined();
  });

  it("labels normalized effort and never displays off for always-on GLM 5.3", () => {
    expect(getQwenCloudThinkingLabel("qwen-cloud/glm-5.3", null)).toBe("Thinking high");
    expect(getQwenCloudThinkingLabel("qwen-cloud/glm-5.3", "max")).toBe("Thinking max");
    expect(getQwenCloudThinkingLabel("qwen-cloud/qwen3.8-max", "high")).toBe("Thinking low");
    expect(getQwenCloudThinkingLabel("qwen-cloud/qwen3.8-max", "xhigh")).toBe("Thinking xhigh");
  });

  it("keeps outbound native contracts closed and credential-free", () => {
    expectTypeOf<keyof QwenCloudConnectionStatus>().toEqualTypeOf<
      "provider" | "credential" | "verification" | "allowance"
    >();
    expectTypeOf<QwenCloudConnectionStatus["verification"]>().toEqualTypeOf<
      "not-tested" | "succeeded"
    >();
    expectTypeOf<
      Extract<QwenCloudConnectionResult, { ok: false }>["code"]
    >().toEqualTypeOf<
      | "invalid-key-format"
      | "native-unavailable"
      | "vault-unavailable"
      | "active-run"
      | "preparation-failed"
      | "reload-failed"
      | "authentication-failed"
      | "allowance-exhausted"
      | "rate-limited"
      | "network-failed"
      | "request-rejected"
      | "timed-out"
    >();
    expectTypeOf<keyof Extract<QwenCloudConnectionResult, { ok: true }>>().toEqualTypeOf<
      "ok" | "status"
    >();
    expectTypeOf<keyof Extract<QwenCloudConnectionResult, { ok: false }>>().toEqualTypeOf<
      "ok" | "code"
    >();
    expectTypeOf<
      Extract<
        Extract<QwenCloudConnectionResult, { ok: false }>["code"],
        "active-run" | "preparation-failed" | "reload-failed"
      >
    >().toEqualTypeOf<"active-run" | "preparation-failed" | "reload-failed">();
    expectTypeOf<
      QwenCloudConnectionStatus["allowance"]
    >().toEqualTypeOf<"unavailable-with-inference-key">();
  });
});
