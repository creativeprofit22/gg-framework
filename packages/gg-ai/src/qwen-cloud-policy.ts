import type { ThinkingLevel } from "./types.js";

/** Code-owned Token Plan policy shared by registry, thinking controls and future transport. */
export const QWEN_CLOUD_PROVIDER = "qwen-cloud" as const;
export const QWEN_CLOUD_TOKEN_PLAN_ENDPOINT =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions" as const;
export const QWEN_CLOUD_TOKEN_PLAN_KEY_ENV = "QWEN_CLOUD_TOKEN_PLAN_KEY" as const;
export const QWEN_CLOUD_TOKEN_PLAN_KEY_PREFIX = "sk-sp-" as const;

/** Documentation checked 2026-09-17. These URLs are evidence, never inference routes. */
export const QWEN_CLOUD_CAPABILITY_SOURCES = {
  overview: "https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview",
  quickstart: "https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart",
  specifications:
    "https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models",
  thinking: "https://docs.qwencloud.com/developer-guides/text-generation/thinking",
  glm: "https://docs.qwencloud.com/developer-guides/third-party-models/glm",
  glm52Marketplace: "https://www.qwencloud.com/models/glm-5.2",
  chat: "https://docs.qwencloud.com/api-reference/chat/openai-chat.md",
  deepseek: "https://docs.qwencloud.com/developer-guides/third-party-models/deepseek",
  releases: "https://docs.qwencloud.com/changelog/models",
} as const;

export const QWEN_CLOUD_API_MODEL_IDS = [
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
] as const;
export type QwenCloudApiModelId = (typeof QWEN_CLOUD_API_MODEL_IDS)[number];
export type QwenCloudModelId = `qwen-cloud/${QwenCloudApiModelId}`;
export const QWEN_CLOUD_DEFAULT_MODEL_ID = "qwen-cloud/qwen3.8-max" satisfies QwenCloudModelId;
export const QWEN_CLOUD_FAST_MODEL_ID = "qwen-cloud/qwen3.8-flash" satisfies QwenCloudModelId;
export const QWEN_CLOUD_SUMMARY_MODEL_ID = QWEN_CLOUD_FAST_MODEL_ID;

/** Binary on is intentional: it is not a cosmetic native reasoning effort. */
export type QwenCloudThinkingPolicy =
  | { readonly kind: "binary"; readonly levels: readonly ["off", "on"] }
  | {
      readonly kind: "effort";
      readonly levels:
        | readonly ["off", "low", "medium", "xhigh"]
        | readonly ["off", "high", "max"]
        | readonly ["off", "low", "high", "max"]
        | readonly ["low", "high", "max"];
    };

export interface QwenCloudModelCapability {
  readonly id: QwenCloudModelId;
  readonly apiModelId: QwenCloudApiModelId;
  readonly provider: typeof QWEN_CLOUD_PROVIDER;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly outputLimitScope: "answer" | "reasoning-and-answer";
  readonly thinking: QwenCloudThinkingPolicy;
  /** Effort-only policy deliberately never emits thinking_budget, including Qwen 3.8. */
  readonly thinkingBudgetPolicy: "omit";
  /** Advertising remains disabled until attachment handling is verified in the adapter step. */
  readonly supportsImages: false;
  readonly sources: readonly (keyof typeof QWEN_CLOUD_CAPABILITY_SOURCES)[];
}

const qwen38 = { kind: "effort", levels: ["off", "low", "medium", "xhigh"] } as const;
const binary = { kind: "binary", levels: ["off", "on"] } as const;
const highMax = { kind: "effort", levels: ["off", "high", "max"] } as const;
const lowHighMax = { kind: "effort", levels: ["off", "low", "high", "max"] } as const;

function capability(
  apiModelId: QwenCloudApiModelId,
  name: string,
  maxOutputTokens: number,
  outputLimitScope: QwenCloudModelCapability["outputLimitScope"],
  thinking: QwenCloudThinkingPolicy,
  sources: QwenCloudModelCapability["sources"],
): QwenCloudModelCapability {
  return {
    id: `qwen-cloud/${apiModelId}`,
    apiModelId,
    provider: QWEN_CLOUD_PROVIDER,
    name,
    contextWindow: 1_000_000,
    maxOutputTokens,
    outputLimitScope,
    thinking,
    thinkingBudgetPolicy: "omit",
    supportsImages: false,
    sources,
  };
}

/**
 * Conservative decimal interpretation of abbreviated 1M/64k/128K/131K/384k documentation:
 * no evidence establishes binary multipliers. See docs/qwen-cloud-token-plan-capabilities.md.
 * The registry derives its catalogue from this matrix; transport is not enabled yet.
 */
export const QWEN_CLOUD_MODEL_CAPABILITIES: readonly QwenCloudModelCapability[] = [
  capability("qwen3.8-max", "Qwen 3.8 Max", 128_000, "answer", qwen38, [
    "specifications",
    "thinking",
  ]),
  capability("qwen3.8-flash", "Qwen 3.8 Flash", 128_000, "answer", qwen38, [
    "specifications",
    "thinking",
  ]),
  capability("qwen3.7-max", "Qwen 3.7 Max", 64_000, "answer", binary, [
    "specifications",
    "thinking",
    "overview",
  ]),
  capability("qwen3.7-plus", "Qwen 3.7 Plus", 64_000, "answer", binary, [
    "specifications",
    "thinking",
  ]),
  capability("qwen3.6-flash", "Qwen 3.6 Flash", 64_000, "answer", binary, [
    "specifications",
    "thinking",
  ]),
  capability(
    "glm-5.3",
    "GLM 5.3",
    128_000,
    "reasoning-and-answer",
    { kind: "effort", levels: ["low", "high", "max"] },
    ["glm", "releases", "chat"],
  ),
  capability("glm-5.2", "GLM 5.2", 131_000, "reasoning-and-answer", highMax, [
    "glm",
    "glm52Marketplace",
    "chat",
  ]),
  capability("deepseek-v4-pro", "DeepSeek V4 Pro", 384_000, "reasoning-and-answer", highMax, [
    "specifications",
    "deepseek",
  ]),
  capability(
    "deepseek-v4-pro-0813",
    "DeepSeek V4 Pro 0813",
    384_000,
    "reasoning-and-answer",
    lowHighMax,
    ["specifications", "deepseek"],
  ),
  capability(
    "deepseek-v4-flash-0731",
    "DeepSeek V4 Flash 0731",
    384_000,
    "reasoning-and-answer",
    lowHighMax,
    ["specifications", "deepseek"],
  ),
  capability(
    "deepseek-v4.1-flash",
    "DeepSeek V4.1 Flash",
    384_000,
    "reasoning-and-answer",
    lowHighMax,
    ["specifications", "deepseek"],
  ),
];

/** Exact internal identity only: bare/direct-provider IDs must not route here. */
export function getQwenCloudCapability(model: string): QwenCloudModelCapability | undefined {
  return QWEN_CLOUD_MODEL_CAPABILITIES.find((entry) => entry.id === model);
}

/** Existing high token represents binary enabled, never a wire effort or display label. */
export function getQwenCloudThinkingLevels(model: string): readonly ThinkingLevel[] {
  const policy = getQwenCloudCapability(model)?.thinking;
  if (!policy) return [];
  if (policy.kind === "binary") return ["high"];
  return policy.levels.filter((level): level is Exclude<typeof level, "off"> => level !== "off");
}

export function normalizeQwenCloudThinking(
  model: string,
  current: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const policy = getQwenCloudCapability(model)?.thinking;
  if (!policy) return undefined;
  const levels = getQwenCloudThinkingLevels(model);
  if (!current) {
    if (policy.levels.some((level) => level === "off")) return undefined;
    return "high";
  }
  return current && levels.includes(current) ? current : levels[0];
}

export function getQwenCloudThinkingLabel(model: string, level: ThinkingLevel | null): string {
  const normalized = normalizeQwenCloudThinking(model, level ?? undefined);
  if (!normalized) return "Thinking off";
  return getQwenCloudCapability(model)?.thinking.kind === "binary"
    ? "Thinking on"
    : `Thinking ${normalized}`;
}
