// Local Fork-owned: Roadmap phase context and phase-lease persistence for
// AgentSession. Kept out of agent-session.ts so upstream syncs stay small.
import crypto from "node:crypto";
import {
  ACTIVE_PHASE_CONTEXT_CLEAR_KIND,
  ACTIVE_PHASE_CONTEXT_KIND,
  ROADMAP_PHASE_LEASE_KIND,
  parseActivePhaseContext,
  parseRoadmapPhaseLeaseMarker,
  renderActivePhasePackage,
  type ActivePhaseContextClearReason,
  type ActivePhaseContextV1,
  type ActivePhaseExecutionStage,
  type RoadmapPhaseLeaseMarkerV1,
} from "../phase-context.js";
import { canonicalProjectKey } from "../project-notes-repository.js";
import type { CustomEntry, SessionManager } from "./session-manager.js";

/** Live AgentSession state read and written by phase-context persistence. */
export interface SessionPhaseContextHost {
  cwd(): string;
  sessionId(): string;
  sessionPath(): string;
  sessionManager(): SessionManager;
  activePhaseContext(): ActivePhaseContextV1 | undefined;
  storeActivePhaseContext(context: ActivePhaseContextV1 | undefined): void;
  leaseMarker(): RoadmapPhaseLeaseMarkerV1 | undefined;
  storeLeaseMarker(marker: RoadmapPhaseLeaseMarkerV1 | undefined): void;
  setPlanModeFlag(planMode: boolean): void;
  setApprovedPlanPath(planPath: string | undefined): void;
  refreshSystemPromptTail(): void;
  rebuildSystemPromptInPlace(): Promise<void>;
}

export async function setRoadmapPhaseLeaseMarker(
  host: SessionPhaseContextHost,
  marker: RoadmapPhaseLeaseMarkerV1,
): Promise<void> {
  const parsed = parseRoadmapPhaseLeaseMarker(marker, {
    projectKey: canonicalProjectKey(host.cwd()),
    phaseId: host.activePhaseContext()?.phase.id,
  });
  if (!parsed) throw new Error("Cannot persist malformed Roadmap phase lease metadata.");
  if (!host.sessionPath()) throw new Error("Roadmap phase leases require a persistent session.");
  const entry: CustomEntry = {
    type: "custom",
    kind: ROADMAP_PHASE_LEASE_KIND,
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    data: parsed,
  };
  await host.sessionManager().appendRequiredEntry(host.sessionPath(), entry);
  host.storeLeaseMarker(parsed);
}

export async function rePersistRoadmapPhaseLeaseMarker(
  host: SessionPhaseContextHost,
): Promise<void> {
  const marker = host.leaseMarker();
  if (!marker || !host.sessionPath()) return;
  const entry: CustomEntry = {
    type: "custom",
    kind: ROADMAP_PHASE_LEASE_KIND,
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    data: marker,
  };
  await host.sessionManager().appendRequiredEntry(host.sessionPath(), entry);
}

export async function setActivePhaseContext(
  host: SessionPhaseContextHost,
  context: ActivePhaseContextV1 | undefined,
): Promise<void> {
  if (context === undefined) {
    await clearActivePhaseContext(host);
    return;
  }
  const parsed = parseActivePhaseContext(context);
  if (!parsed) throw new Error("Cannot activate malformed phase context.");
  if (parsed.projectKey !== canonicalProjectKey(host.cwd())) {
    throw new Error("Cannot activate phase context from another project.");
  }
  // Rendering applies the deterministic package budget before metadata is persisted.
  const activeContext = await rePersistActivePhaseContext(
    host,
    renderActivePhasePackage(parsed).context,
  );
  if (!activeContext) throw new Error("Cannot activate phase context without metadata.");
  restorePlanStateFromActivePhase(host, activeContext);
  host.refreshSystemPromptTail();
}

export async function clearActivePhaseContext(
  host: SessionPhaseContextHost,
  reason: ActivePhaseContextClearReason = "cleared",
): Promise<void> {
  const phaseId = host.activePhaseContext()?.phase.id ?? null;
  if (host.sessionPath()) {
    const entry: CustomEntry = {
      type: "custom",
      kind: ACTIVE_PHASE_CONTEXT_CLEAR_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: {
        version: 1,
        projectKey: canonicalProjectKey(host.cwd()),
        phaseId,
        reason,
      },
    };
    await host.sessionManager().appendRequiredEntry(host.sessionPath(), entry);
  }
  host.storeActivePhaseContext(undefined);
  host.storeLeaseMarker(undefined);
  host.refreshSystemPromptTail();
}

export async function updateActivePhaseStage(
  host: SessionPhaseContextHost,
  executionStage: ActivePhaseExecutionStage,
  approvedPlanPath?: string,
): Promise<ActivePhaseContextV1> {
  const current = host.activePhaseContext();
  if (!current) throw new Error("No active phase context is bound.");
  const activeContext = await rePersistActivePhaseContext(host, {
    ...current,
    executionStage,
    ...(approvedPlanPath ? { approvedPlanPath } : { approvedPlanPath: undefined }),
  });
  if (!activeContext) throw new Error("No active phase context is bound.");
  restorePlanStateFromActivePhase(host, activeContext);
  await host.rebuildSystemPromptInPlace();
  host.refreshSystemPromptTail();
  return structuredClone(activeContext);
}

export function restorePlanStateFromActivePhase(
  host: SessionPhaseContextHost,
  context: ActivePhaseContextV1,
): void {
  host.setPlanModeFlag(
    context.executionStage === "planning" || context.executionStage === "awaiting-approval",
  );
  host.setApprovedPlanPath(
    context.executionStage === "implementing" ? context.approvedPlanPath : undefined,
  );
}

export async function ensureActivePhaseSessionMetadata(
  host: SessionPhaseContextHost,
): Promise<void> {
  const context = host.activePhaseContext();
  if (!context || !host.sessionPath()) return;
  if (
    context.session.sessionId === host.sessionId() &&
    context.session.sessionPath === host.sessionPath()
  ) {
    return;
  }
  await rePersistActivePhaseContext(host, context);
}

export async function rePersistActivePhaseContext(
  host: SessionPhaseContextHost,
  context: ActivePhaseContextV1 | undefined = host.activePhaseContext(),
): Promise<ActivePhaseContextV1 | undefined> {
  if (!context) return undefined;
  const synchronizedContext = host.sessionId()
    ? {
        ...context,
        session: { sessionId: host.sessionId(), sessionPath: host.sessionPath() || null },
      }
    : context;
  if (host.sessionPath()) {
    const entry: CustomEntry = {
      type: "custom",
      kind: ACTIVE_PHASE_CONTEXT_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: synchronizedContext,
    };
    await host.sessionManager().appendRequiredEntry(host.sessionPath(), entry);
  }
  host.storeActivePhaseContext(synchronizedContext);
  return synchronizedContext;
}
