import type { Provider } from "@kenkaiiii/gg-ai";

export const DEFAULT_COMPACTION_THRESHOLD = 0.85;

export interface CompactionPolicy {
  threshold: number;
  targetTokens: number;
  policyKey: string;
}

/** One trigger policy shared by app sessions and CLI compaction. */
export function resolveCompactionPolicy(options: {
  provider: Provider;
  model: string;
  contextWindow: number;
  threshold?: number;
  accountId?: string;
  approvedPlanPath?: string;
}): CompactionPolicy {
  const threshold =
    Number.isFinite(options.threshold) && options.threshold! > 0 && options.threshold! < 1
      ? options.threshold!
      : DEFAULT_COMPACTION_THRESHOLD;
  const targetTokens = Math.max(1, Math.ceil(options.contextWindow * threshold));
  const transport =
    options.provider === "openai" && options.accountId ? "codex_oauth" : "public_api";
  return {
    threshold,
    targetTokens,
    policyKey: JSON.stringify({
      provider: options.provider,
      model: options.model,
      transport,
      contextWindow: options.contextWindow,
      threshold,
      approvedPlanPath: options.approvedPlanPath ?? null,
    }),
  };
}
