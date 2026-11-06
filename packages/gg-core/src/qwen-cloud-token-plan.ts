import type { QWEN_CLOUD_PROVIDER } from "@kenkaiiii/gg-ai/qwen-cloud-policy";

// Policy lives below gg-core so provider adapters can consume it without a dependency cycle.
export {
  QWEN_CLOUD_PROVIDER,
  getQwenCloudThinkingLabel,
  QWEN_CLOUD_TOKEN_PLAN_ENDPOINT,
  QWEN_CLOUD_TOKEN_PLAN_KEY_ENV,
  QWEN_CLOUD_TOKEN_PLAN_KEY_PREFIX,
  QWEN_CLOUD_CAPABILITY_SOURCES,
  QWEN_CLOUD_API_MODEL_IDS,
  QWEN_CLOUD_DEFAULT_MODEL_ID,
  QWEN_CLOUD_FAST_MODEL_ID,
  QWEN_CLOUD_SUMMARY_MODEL_ID,
  QWEN_CLOUD_MODEL_CAPABILITIES,
  type QwenCloudApiModelId,
  type QwenCloudModelId,
  type QwenCloudThinkingPolicy,
  type QwenCloudModelCapability,
} from "@kenkaiiii/gg-ai/qwen-cloud-policy";

/** Native-to-webview contracts: no key, endpoint override, raw error, or quota estimate. */
export interface QwenCloudConnectionStatus {
  readonly provider: typeof QWEN_CLOUD_PROVIDER;
  readonly credential: "saved" | "absent" | "unavailable";
  /** Saving locally does not establish authentication or subscription entitlement. */
  readonly verification: "not-tested" | "succeeded";
  readonly allowance: "unavailable-with-inference-key";
}

export type QwenCloudConnectionErrorCode =
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
  | "timed-out";

/** Consumers map closed codes to fixed copy; upstream messages must never cross IPC. */
export type QwenCloudConnectionResult =
  | { readonly ok: true; readonly status: QwenCloudConnectionStatus }
  | { readonly ok: false; readonly code: QwenCloudConnectionErrorCode };
