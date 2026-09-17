// Test-only bridge: exercise real reconciliation without adding server modules to the app's TypeScript compilation.
import { randomUUID } from "node:crypto";
import { confirmRecommendationCorrespondence, decideRecommendation, emptyRecommendationHistory,
  reconcileRecommendations, recommendationDetail } from "../../packages/ggcoder/src/core/programmatic/recommendations.ts";

export function recommendationHistoryFixture(decision) {
  const at = "2026-09-16T00:00:00.000Z";
  const capture = () => ({ assessment: { version: 1, id: randomUUID(), startedAt: at, finishedAt: at,
    mode: "configured", outcome: "completed", hostCoverage: [] },
    observations: [{ version: 1, outcome: "<b>Saved outcome</b>", rationale: "Repeated review", uncertainty: "Not verified",
      workflow: { trigger: "Entries change", representativeCase: "Entry", inputs: ["Entries"], currentProcess: ["Review"], output: "Report",
        successCheck: "Compare entries", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read only",
        repeatability: { basis: "inferred", explanation: "Entries change" } },
      choice: { kind: "manual", steps: ["Review separately"] }, alternatives: [], evidence: [] }] });
  const input = capture();
  if (!decision) {
    input.observations.push(structuredClone(input.observations[0]));
    const history = reconcileRecommendations(emptyRecommendationHistory(), input).history;
    return { detail: recommendationDetail(history, history.candidates[0].id, 0), canonical: null };
  }
  let history = reconcileRecommendations(emptyRecommendationHistory(), input).history;
  const canonicalId = history.candidates[0].id;
  history = decideRecommendation(history, { candidateId: canonicalId, expectedRevision: 1, decision }, at);
  const later = capture(); later.observations[0].workflow.trigger = "Entries updated";
  history = reconcileRecommendations(history, later).history;
  const retained = history.candidates.find((item) => item.id !== canonicalId);
  history = confirmRecommendationCorrespondence(history, { canonicalId, canonicalRevision: 2,
    retainedId: retained.id, retainedRevision: 1 }, at);
  return { detail: recommendationDetail(history, retained.id, 0), canonical: recommendationDetail(history, canonicalId, 0) };
}
