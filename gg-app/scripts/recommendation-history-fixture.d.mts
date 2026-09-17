import type { RecommendationDetail } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
export function recommendationHistoryFixture(decision: "dismissed" | "completed"): {
  detail: RecommendationDetail; canonical: RecommendationDetail;
};
export function recommendationHistoryFixture(): { detail: RecommendationDetail; canonical: null };
