import type {
  ProgrammaticAreaProgress,
  ProgrammaticAssessment,
  ProgrammaticAssessmentArea,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { DiscoveryCandidate } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { programmaticChatReducer, type ProgrammaticChatState } from "./programmatic-chat-state";

/** Synthetic area-search lifecycle for offline component tests; no provider or host involved. */
export const areaIdentity = {
  conversationId: "chat",
  sessionId: "session",
  sequence: 1,
  requestId: "find-1",
} as const;

export const docsFind = {
  need: "Release notes are rewritten by hand each release",
  where: "docs/releases",
  unsure: "Only two releases were read",
};

export const liveAreas = (
  api: ProgrammaticAreaProgress["status"],
  scripts: ProgrammaticAreaProgress["status"],
): ProgrammaticAreaProgress[] => [
  { id: "docs", label: "docs", status: "found", finds: [docsFind] },
  { id: "api", label: "src/api", status: api },
  {
    id: "scripts",
    label: "scripts",
    status: scripts,
    ...(scripts === "partly" ? { finds: [] } : {}),
  },
];

export const finalAreas: ProgrammaticAssessmentArea[] = [
  { id: "docs", label: "docs", status: "searched", retryable: false },
  { id: "api", label: "src/api", status: "not-searched", reason: "failed", retryable: true },
  { id: "scripts", label: "scripts", status: "partly", reason: "limit", retryable: false },
];

export function startSearch(state: ProgrammaticChatState): ProgrammaticChatState {
  const started = programmaticChatReducer(state, {
    type: "start",
    generation: state.generation,
    epoch: state.epoch + 1,
    operation: "discover",
    assessmentRequest: areaIdentity,
  });
  return programmaticChatReducer(started, {
    type: "assessment",
    generation: state.generation,
    event: { ...areaIdentity, phase: "started" },
  });
}

export function progress(
  state: ProgrammaticChatState,
  stage: "areas" | "merging",
  areas: ProgrammaticAreaProgress[],
): ProgrammaticChatState {
  return programmaticChatReducer(state, {
    type: "assessment",
    generation: state.generation,
    event: { ...areaIdentity, phase: "progress", stage, areas },
  });
}

export function areaAssessment(
  status: ProgrammaticAssessment["status"],
  candidates: DiscoveryCandidate[] | null,
): ProgrammaticAssessment {
  return {
    version: 1,
    lifecycle: areaIdentity,
    mode: "configured",
    status,
    summary: `Area search ${status}.`,
    limitations: [],
    coverage: [],
    observations: [],
    deterministic: { status: "succeeded", enabledCount: 1, applicableCount: 1 },
    ...(candidates ? { discovery: { assessmentId: "area-search", candidates } } : {}),
    areas: finalAreas,
  };
}

/** Delivers the completed event and the matching discover receipt, as the host does. */
export function finishSearch(
  state: ProgrammaticChatState,
  assessment: ProgrammaticAssessment,
): ProgrammaticChatState {
  const completed = programmaticChatReducer(state, {
    type: "assessment",
    generation: state.generation,
    event: { ...areaIdentity, phase: "completed", assessment },
  });
  return programmaticChatReducer(completed, {
    type: "response",
    generation: state.generation,
    epoch: state.epoch,
    response: { version: 1, action: "discover", ok: true, assessment },
  });
}
