import {
  DECISION_SUMMARY_CONTEXT_MAX_BYTES,
  parseDecisionSummaryContext,
  type AppSidecarDecisionSummaryService,
  type DecisionSummarySourceSession,
} from "./app-sidecar-decision-summary.js";

export interface DecisionSummaryRouteResponse {
  status: number;
  body: unknown;
}

export async function handleDecisionSummaryRequest(
  raw: string,
  sourceSession: DecisionSummarySourceSession,
  service: Pick<AppSidecarDecisionSummaryService, "summarize">,
): Promise<DecisionSummaryRouteResponse> {
  if (Buffer.byteLength(raw, "utf8") > DECISION_SUMMARY_CONTEXT_MAX_BYTES) {
    return { status: 413, body: { error: "decision summary context is too large" } };
  }
  let context: unknown;
  try {
    context = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "invalid decision summary context" } };
  }
  try {
    const result = await service.summarize(sourceSession, parseDecisionSummaryContext(context));
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof Error && error.message === "invalid summary context") {
      return { status: 400, body: { error: "invalid decision summary context" } };
    }
    return { status: 502, body: { error: "decision summary unavailable" } };
  }
}
