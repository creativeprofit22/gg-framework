import { randomUUID } from "node:crypto";
import { canonicalProjectKey } from "@kenkaiiii/gg-core/project-notes";
import {
  validateRoadmapPhaseDraftRequest,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftApprovalResult,
  type RoadmapPhaseDraftRejectionResult,
  type RoadmapPhaseDraftRequest,
} from "@kenkaiiii/gg-core/roadmap-workflow";

export interface RoadmapPhaseDraftCreateRequest {
  cwd: string;
  sessionId: string;
  request: RoadmapPhaseDraftRequest;
}

export type RoadmapPhaseDraftCreateResult =
  | { status: "drafted"; draft: RoadmapPhaseDraft }
  | { status: "proposal-pending"; draft: RoadmapPhaseDraft }
  | { status: "invalid-proposal"; path: string; message: string };

export interface AppSidecarRoadmapDraftCoordinatorOptions {
  createId?: () => string;
  now?: () => string;
  maxDecisionTombstones?: number;
  onChange?: (projectKey: string, draft: RoadmapPhaseDraft | null) => void;
}

type DecisionTombstone =
  | {
      projectKey: string;
      decision: "approved";
      result: Extract<RoadmapPhaseDraftApprovalResult, { status: "created" }>;
    }
  | {
      projectKey: string;
      decision: "rejected";
      result: Extract<RoadmapPhaseDraftRejectionResult, { status: "rejected" }>;
      feedback: string | null;
    };

interface ApprovalInFlight {
  projectKey: string;
  promise: Promise<RoadmapPhaseDraftApprovalResult>;
}

/** Daemon-ephemeral authority for one pending flat phase proposal per project. */
export class AppSidecarRoadmapDraftCoordinator {
  private readonly pendingByProject = new Map<string, RoadmapPhaseDraft>();
  private readonly projectByDraftId = new Map<string, string>();
  private readonly decisions = new Map<string, DecisionTombstone>();
  private readonly approvals = new Map<string, ApprovalInFlight>();
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly maxDecisionTombstones: number;

  constructor(private readonly options: AppSidecarRoadmapDraftCoordinatorOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxDecisionTombstones = Math.max(1, options.maxDecisionTombstones ?? 256);
  }

  pending(cwd: string): RoadmapPhaseDraft | null {
    return cloneDraft(this.pendingByProject.get(canonicalProjectKey(cwd)) ?? null);
  }

  create(input: RoadmapPhaseDraftCreateRequest): RoadmapPhaseDraftCreateResult {
    const validated = validateRoadmapPhaseDraftRequest(input.request);
    if (!validated.ok) {
      return {
        status: "invalid-proposal",
        path: validated.error.path,
        message: validated.error.message,
      };
    }
    const projectKey = canonicalProjectKey(input.cwd);
    const existing = this.pendingByProject.get(projectKey);
    if (existing) {
      this.emit(projectKey, existing);
      return { status: "proposal-pending", draft: cloneDraft(existing)! };
    }

    const draftId = this.createId();
    const referenceIdsByKey = new Map<string, string>();
    const references = (validated.value.proposedReferences ?? []).map(
      ({ referenceKey, ...reference }) => {
        const referenceId = this.createId();
        referenceIdsByKey.set(referenceKey, referenceId);
        return { id: referenceId, ...reference };
      },
    );
    const phases = validated.value.phases.map(({ referenceKeys, ...phase }) => ({
      phaseId: this.createId(),
      ...phase,
      referenceIds: (referenceKeys ?? []).map((key) => referenceIdsByKey.get(key)!),
    }));
    const draft: RoadmapPhaseDraft = {
      id: draftId,
      projectKey,
      basedOnRevision: validated.value.expectedRevision,
      createdAt: this.now(),
      createdBySessionId: input.sessionId,
      summary: validated.value.summary,
      references,
      phases,
      status: "pending",
    };
    this.pendingByProject.set(projectKey, draft);
    this.projectByDraftId.set(draft.id, projectKey);
    this.emit(projectKey, draft);
    return { status: "drafted", draft: cloneDraft(draft)! };
  }

  async approve(
    cwd: string,
    draftId: string,
    commit: (draft: RoadmapPhaseDraft) => Promise<RoadmapPhaseDraftApprovalResult>,
  ): Promise<RoadmapPhaseDraftApprovalResult> {
    const projectKey = canonicalProjectKey(cwd);
    const prior = this.decisions.get(draftId);
    if (prior) return alreadyDecidedApproval(prior, projectKey);

    const inFlight = this.approvals.get(draftId);
    if (inFlight) {
      return inFlight.projectKey === projectKey
        ? inFlight.promise
        : { status: "proposal-project-mismatch" };
    }

    const located = this.locate(projectKey, draftId);
    if (located.status !== "found") return located.result;

    const promise = this.commitApproval(projectKey, located.draft, commit);
    this.approvals.set(draftId, { projectKey, promise });
    try {
      return await promise;
    } finally {
      if (this.approvals.get(draftId)?.promise === promise) this.approvals.delete(draftId);
    }
  }

  async reject(
    cwd: string,
    draftId: string,
    feedback: string | null = null,
  ): Promise<RoadmapPhaseDraftRejectionResult> {
    const projectKey = canonicalProjectKey(cwd);
    const prior = this.decisions.get(draftId);
    if (prior) return alreadyDecidedRejection(prior, projectKey);

    const inFlight = this.approvals.get(draftId);
    if (inFlight) {
      if (inFlight.projectKey !== projectKey) {
        return { status: "proposal-project-mismatch" };
      }
      try {
        await inFlight.promise;
      } catch {
        // A failed approval leaves the proposal pending so this explicit rejection can win.
      }
      const decided = this.decisions.get(draftId);
      if (decided) return alreadyDecidedRejection(decided, projectKey);
    }

    const located = this.locate(projectKey, draftId);
    if (located.status !== "found") return located.result;

    this.removePending(located.draft);
    const result = { status: "rejected" } as const;
    this.rememberDecision(draftId, {
      projectKey,
      decision: "rejected",
      result,
      feedback,
    });
    this.emit(projectKey, null);
    return result;
  }

  private async commitApproval(
    projectKey: string,
    draft: RoadmapPhaseDraft,
    commit: (draft: RoadmapPhaseDraft) => Promise<RoadmapPhaseDraftApprovalResult>,
  ): Promise<RoadmapPhaseDraftApprovalResult> {
    const result = await commit(cloneDraft(draft)!);
    if (result.status === "created") {
      this.removePending(draft);
      this.rememberDecision(draft.id, { projectKey, decision: "approved", result });
      this.emit(projectKey, null);
    } else if (result.status === "stale-revision") {
      const current = this.pendingByProject.get(projectKey);
      if (current?.id === draft.id && current.status !== "stale") {
        const stale = { ...current, status: "stale" as const };
        this.pendingByProject.set(projectKey, stale);
        this.emit(projectKey, stale);
      }
    }
    return result;
  }

  private locate(
    projectKey: string,
    draftId: string,
  ):
    | { status: "found"; draft: RoadmapPhaseDraft }
    | {
        status: "missing";
        result: { status: "proposal-not-found" } | { status: "proposal-project-mismatch" };
      } {
    const knownProject =
      this.projectByDraftId.get(draftId) ?? this.decisions.get(draftId)?.projectKey;
    if (knownProject && knownProject !== projectKey) {
      return { status: "missing", result: { status: "proposal-project-mismatch" } };
    }
    const pending = this.pendingByProject.get(projectKey);
    return pending?.id === draftId
      ? { status: "found", draft: pending }
      : { status: "missing", result: { status: "proposal-not-found" } };
  }

  private removePending(draft: RoadmapPhaseDraft): void {
    if (this.pendingByProject.get(draft.projectKey)?.id === draft.id) {
      this.pendingByProject.delete(draft.projectKey);
    }
  }

  private rememberDecision(draftId: string, decision: DecisionTombstone): void {
    this.decisions.delete(draftId);
    this.decisions.set(draftId, decision);
    while (this.decisions.size > this.maxDecisionTombstones) {
      const oldest = this.decisions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.decisions.delete(oldest);
      this.projectByDraftId.delete(oldest);
    }
  }

  private emit(projectKey: string, draft: RoadmapPhaseDraft | null): void {
    this.options.onChange?.(projectKey, cloneDraft(draft));
  }
}

function alreadyDecidedApproval(
  decision: DecisionTombstone,
  projectKey: string,
): RoadmapPhaseDraftApprovalResult {
  if (decision.projectKey !== projectKey) return { status: "proposal-project-mismatch" };
  return decision.decision === "approved"
    ? { ...decision.result, phaseIds: [...decision.result.phaseIds] }
    : { status: "already-decided", decision: "rejected" };
}

function alreadyDecidedRejection(
  decision: DecisionTombstone,
  projectKey: string,
): RoadmapPhaseDraftRejectionResult {
  if (decision.projectKey !== projectKey) return { status: "proposal-project-mismatch" };
  return decision.decision === "rejected"
    ? decision.result
    : { status: "already-decided", decision: "approved" };
}

function cloneDraft(draft: RoadmapPhaseDraft | null): RoadmapPhaseDraft | null {
  if (!draft) return null;
  return {
    ...draft,
    references: draft.references.map((reference) => ({
      ...reference,
      range: reference.range ? { ...reference.range } : null,
    })),
    phases: draft.phases.map((phase) => ({
      ...phase,
      doneWhen: [...phase.doneWhen],
      referenceIds: [...phase.referenceIds],
    })),
  };
}
