import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { ImageContent, ThinkingLevel } from "@kenkaiiii/gg-ai";

export interface CompletionReviewRequest {
  instruction: string;
  context: string;
  images: ImageContent[];
}
export interface CompletionReviewResponse {
  text: string;
  model: string;
  provider: string;
  thinking: ThinkingLevel | undefined;
}
export type CompletionReviewer = (
  request: CompletionReviewRequest,
  signal: AbortSignal,
) => Promise<CompletionReviewResponse>;
/** Optional host policy. No default policy: ordinary Coder/chat sessions are unchanged. */
export interface CompletionReview {
  readonly armed: boolean;
  begin(request: string): void;
  track(event: AgentEvent): Promise<void>;
  followUp(review: CompletionReviewer, signal?: AbortSignal): Promise<string | null>;
  snapshot(): unknown;
  restore(data: unknown): void;
}
export const COMPLETION_REVIEW_STATE_KIND = "completion-review-v1";
