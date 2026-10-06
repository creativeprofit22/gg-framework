import type { ProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

/** Synthetic offline equivalents of denied inspection and a bounded readable no-op. */
export function emptyDiscoveryAssessment(inspected: boolean): ProgrammaticAssessment {
  return {
    version: 1,
    mode: "configured",
    status: "completed",
    summary: "Bounded needs assessment completed; recommendations are advisory.",
    limitations: inspected
      ? ["Only the two static documentation files were inspected."]
      : ["All six source reads were denied; workflows and recurrence cannot be established."],
    coverage: [
      {
        scope: "project",
        status: "uninspected",
        summary: "Project-wide coverage is not established.",
      },
      {
        scope: "project",
        status: inspected ? "inspected" : "uninspected",
        summary: inspected
          ? "Two static documentation files were read; no recurring unmet workflow was identified within that scope."
          : "No local source evidence was delivered; needs could not be assessed.",
      },
      {
        scope: "catalog",
        status: "inspected",
        summary: "Catalog inspection does not establish project coverage.",
      },
    ],
    observations: [],
    deterministic: { status: "succeeded", enabledCount: 1, applicableCount: 1 },
    discovery: { assessmentId: "54df729b-2d8c-4a9f-abdc-ae6584a70742", candidates: [] },
  };
}
