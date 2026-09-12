import type { ProjectNotesSnapshot } from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_DRAFT_FEEDBACK_MAX_LENGTH,
  normalizeRoadmapWorkflowText,
  type RoadmapPhaseDraftApprovalResult,
  type RoadmapPhaseDraftRejectionResult,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import type { ProjectNotesRepository } from "./project-notes-repository.js";
import type { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";

export interface AppSidecarRoadmapDraftDecisionServiceDependencies {
  drafts: AppSidecarRoadmapDraftCoordinator;
  repository: Pick<ProjectNotesRepository, "createApprovedPhases" | "load">;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  onCommittedSnapshot: (snapshot: ProjectNotesSnapshot) => void;
}

/** Authoritative project-scoped approve/reject transaction used by the HTTP route. */
export class AppSidecarRoadmapDraftDecisionService {
  constructor(private readonly dependencies: AppSidecarRoadmapDraftDecisionServiceDependencies) {}

  pending(cwd: string) {
    return this.dependencies.drafts.pending(cwd);
  }

  async approve(cwd: string, draftId: string): Promise<RoadmapPhaseDraftApprovalResult> {
    let committedSnapshot: ProjectNotesSnapshot | null = null;
    const result = await this.dependencies.drafts.approve(cwd, draftId, async (draft) => {
      const lease = this.dependencies.reconciliations.tryAcquire(cwd, "phase-create");
      if (!lease) return { status: "reconciliation-in-progress" };
      try {
        const creation = await this.dependencies.repository.createApprovedPhases(cwd, draft);
        if (creation.status === "created") {
          const loaded = await this.dependencies.repository.load(cwd);
          if (loaded.status === "ok" && loaded.snapshot.revision >= creation.revision) {
            committedSnapshot = loaded.snapshot;
          }
        }
        return creation;
      } catch (error) {
        return {
          status: "storage-failed",
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        lease.release();
      }
    });
    if (committedSnapshot) this.dependencies.onCommittedSnapshot(committedSnapshot);
    return result;
  }

  async reject(
    cwd: string,
    draftId: string,
    feedback: string | null,
  ): Promise<RoadmapPhaseDraftRejectionResult> {
    return this.dependencies.drafts.reject(cwd, draftId, feedback);
  }
}

export type RoadmapPhaseDraftRoute =
  | { action: "pending" }
  | { action: "approve"; draftId: string }
  | { action: "reject"; draftId: string };

export type RoadmapPhaseDraftRouteParseResult =
  | { status: "matched"; route: RoadmapPhaseDraftRoute }
  | { status: "invalid-path" }
  | { status: "not-matched" };

export function parseRoadmapPhaseDraftRoute(
  method: string,
  url: string,
): RoadmapPhaseDraftRouteParseResult {
  if (method === "GET" && url === "/roadmap/phase-drafts/pending") {
    return { status: "matched", route: { action: "pending" } };
  }
  if (method !== "POST") return { status: "not-matched" };
  const match = /^\/roadmap\/phase-drafts\/([^/]+)\/(approve|reject)$/.exec(url);
  if (!match) return { status: "not-matched" };
  try {
    const draftId = decodeURIComponent(match[1] ?? "");
    if (!draftId.trim()) return { status: "invalid-path" };
    return {
      status: "matched",
      route: { action: match[2] as "approve" | "reject", draftId },
    };
  } catch {
    return { status: "invalid-path" };
  }
}

export type RoadmapPhaseDraftRejectBodyResult =
  | { status: "ok"; feedback: string | null }
  | { status: "invalid"; message: string };

export function parseRoadmapPhaseDraftRejectBody(raw: string): RoadmapPhaseDraftRejectBodyResult {
  let value: unknown;
  try {
    value = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return { status: "invalid", message: "invalid JSON body" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "invalid", message: "expected an object body" };
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "feedback")) {
    return { status: "invalid", message: "unexpected rejection field" };
  }
  if (record.feedback === undefined || record.feedback === null) {
    return { status: "ok", feedback: null };
  }
  if (typeof record.feedback !== "string") {
    return { status: "invalid", message: "feedback must be a string" };
  }
  const feedback = normalizeRoadmapWorkflowText(record.feedback);
  if (Array.from(feedback).length > ROADMAP_DRAFT_FEEDBACK_MAX_LENGTH) {
    return {
      status: "invalid",
      message: `feedback must be at most ${ROADMAP_DRAFT_FEEDBACK_MAX_LENGTH} characters`,
    };
  }
  return { status: "ok", feedback: feedback || null };
}

export function roadmapPhaseDraftApprovalHttpStatus(
  result: RoadmapPhaseDraftApprovalResult,
): number {
  switch (result.status) {
    case "created":
    case "already-decided":
      return 200;
    case "proposal-not-found":
      return 404;
    case "stale-revision":
    case "proposal-project-mismatch":
    case "reconciliation-in-progress":
      return 409;
    case "notes-missing":
      return 404;
    case "notes-corrupt":
    case "invalid-proposal":
      return 422;
    case "storage-failed":
      return 500;
  }
}

export function roadmapPhaseDraftRejectionHttpStatus(
  result: RoadmapPhaseDraftRejectionResult,
): number {
  switch (result.status) {
    case "rejected":
    case "already-decided":
      return 200;
    case "proposal-not-found":
      return 404;
    case "proposal-project-mismatch":
      return 409;
  }
}
