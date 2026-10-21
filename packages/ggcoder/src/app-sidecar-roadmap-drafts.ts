import { randomUUID } from "node:crypto";
import { canonicalProjectKey, type NotesPhase } from "@kenkaiiii/gg-core/project-notes";
import {
  buildRoadmapPhaseEditChanges,
  buildRoadmapPhaseInsertionPreview,
  classifyRoadmapPhaseEditability,
  describeRoadmapPhaseOrderRefusal,
  isRoadmapPhaseEditDraft,
  isRoadmapPhaseMoveDraft,
  moveRoadmapPhaseOrderEntry,
  planRoadmapPhaseMove,
  roadmapPhaseMovePlacement,
  roadmapPhaseOrderEntries,
  validateRoadmapPhaseCreateDraft,
  validateRoadmapPhaseEditDraft,
  validateRoadmapPhaseDraftRequest,
  validateRoadmapPhaseEditRequest,
  validateRoadmapPhaseInsertionTarget,
  validateRoadmapPhaseMoveDraft,
  validateRoadmapPhaseMoveRequest,
  type RoadmapPhaseCreateDraft,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftApprovalResult,
  type RoadmapPhaseDraftRejectionResult,
  type RoadmapPhaseDraftRequest,
  type RoadmapPhaseEditDraft,
  type RoadmapPhaseEditRequest,
  type RoadmapPhaseMoveDraft,
  type RoadmapPhaseMoveRequest,
  type RoadmapPhaseNotEditableReason,
  type RoadmapPhaseOrderPreview,
  type RoadmapPhaseOrderRefusal,
} from "@kenkaiiii/gg-core/roadmap-workflow";

export interface RoadmapPhaseDraftCreateRequest {
  cwd: string;
  sessionId: string;
  request: RoadmapPhaseDraftRequest;
  /** Phases at the inspected revision; required when a proposed phase sets `insertBeforePhaseId`. */
  currentPhases?: readonly NotesPhase[];
}

export interface RoadmapPhaseMoveDraftCreateRequest {
  cwd: string;
  sessionId: string;
  request: RoadmapPhaseMoveRequest;
  /** Phases at the inspected revision. */
  currentPhases: readonly NotesPhase[];
}

export type RoadmapPhaseMoveDraftCreateResult =
  | { status: "drafted"; draft: RoadmapPhaseMoveDraft }
  | Exclude<RoadmapPhaseDraftCreateResult, { status: "drafted" }>
  | { status: "order-refused"; refusal: RoadmapPhaseOrderRefusal };

export type RoadmapPhaseDraftCreateResult =
  | { status: "drafted"; draft: RoadmapPhaseCreateDraft }
  | { status: "proposal-pending"; draft: RoadmapPhaseDraft }
  | { status: "invalid-proposal"; path: string; message: string };

export interface RoadmapPhaseEditDraftCreateRequest {
  cwd: string;
  sessionId: string;
  request: RoadmapPhaseEditRequest;
  /** The target phase as read from the inspected Notes revision. */
  phase: NotesPhase;
}

export type RoadmapPhaseEditDraftCreateResult =
  | { status: "drafted"; draft: RoadmapPhaseEditDraft }
  | Exclude<RoadmapPhaseDraftCreateResult, { status: "drafted" }>
  | { status: "phase-not-editable"; phaseId: string; reason: RoadmapPhaseNotEditableReason }
  | { status: "no-changes"; phaseId: string };

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
      result: Extract<RoadmapPhaseDraftApprovalResult, { status: "created" | "edited" | "moved" }>;
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
    const blocking = this.blockingProposal(projectKey, input.sessionId);
    if (blocking) return { status: "proposal-pending", draft: blocking };

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
    let orderPreview: RoadmapPhaseOrderPreview | undefined;
    if (phases.some((phase) => phase.insertBeforePhaseId !== undefined)) {
      const currentPhases = input.currentPhases;
      if (!currentPhases) {
        return {
          status: "invalid-proposal",
          path: "phases",
          message: "expected the inspected Roadmap to place inserted phases",
        };
      }
      for (let index = 0; index < phases.length; index += 1) {
        const target = phases[index]!.insertBeforePhaseId;
        if (target === undefined) continue;
        const refusal = validateRoadmapPhaseInsertionTarget(currentPhases, target);
        if (refusal) {
          return {
            status: "invalid-proposal",
            path: `phases[${index}].insertBeforePhaseId`,
            message: describeRoadmapPhaseOrderRefusal(refusal),
          };
        }
      }
      orderPreview = buildRoadmapPhaseInsertionPreview(currentPhases, phases);
    }
    const candidate: RoadmapPhaseCreateDraft = {
      id: draftId,
      projectKey,
      basedOnRevision: validated.value.expectedRevision,
      createdAt: this.now(),
      createdBySessionId: input.sessionId,
      summary: validated.value.summary,
      references,
      phases,
      sourcesNotCited: validated.value.sourcesNotCited ?? null,
      ...(orderPreview ? { orderPreview } : {}),
      status: "pending",
    };
    // Legacy appends skip re-validation so their stored shape stays exactly as before.
    let draft = candidate;
    if (orderPreview) {
      const checked = validateRoadmapPhaseCreateDraft(candidate);
      if (!checked.ok) {
        return {
          status: "invalid-proposal",
          path: checked.error.path,
          message: checked.error.message,
        };
      }
      draft = checked.value;
    }
    this.store(projectKey, draft);
    return { status: "drafted", draft: cloneCreateDraft(draft) };
  }

  /** Proposes moving one existing phase; shares the one-pending-per-project slot. */
  createMove(input: RoadmapPhaseMoveDraftCreateRequest): RoadmapPhaseMoveDraftCreateResult {
    const validated = validateRoadmapPhaseMoveRequest(input.request);
    if (!validated.ok) {
      return {
        status: "invalid-proposal",
        path: validated.error.path,
        message: validated.error.message,
      };
    }
    const request = validated.value;
    const projectKey = canonicalProjectKey(input.cwd);
    const blocking = this.blockingProposal(projectKey, input.sessionId);
    if (blocking) return { status: "proposal-pending", draft: blocking };
    const placement = roadmapPhaseMovePlacement(request);
    const planned = planRoadmapPhaseMove(input.currentPhases, request.phaseId, placement);
    if (!planned.ok) return { status: "order-refused", refusal: planned.refusal };
    const before = roadmapPhaseOrderEntries(input.currentPhases);
    const after = moveRoadmapPhaseOrderEntry(before, request.phaseId, placement);
    const phase = input.currentPhases.find((candidate) => candidate.id === request.phaseId);
    const target = input.currentPhases.find(
      (candidate) => candidate.id === placement.targetPhaseId,
    );
    if (!after || !phase || !target) {
      return {
        status: "invalid-proposal",
        path: "phaseId",
        message: "expected both phases on the inspected Roadmap",
      };
    }
    const candidate: RoadmapPhaseMoveDraft = {
      kind: "move",
      id: this.createId(),
      projectKey,
      basedOnRevision: request.expectedRevision,
      createdAt: this.now(),
      createdBySessionId: input.sessionId,
      summary: request.summary,
      phaseId: request.phaseId,
      phaseTitle: phase.title,
      position: placement.position,
      targetPhaseId: placement.targetPhaseId,
      targetPhaseTitle: target.title,
      orderPreview: { before, after },
      status: "pending",
    };
    const checked = validateRoadmapPhaseMoveDraft(candidate);
    if (!checked.ok) {
      return {
        status: "invalid-proposal",
        path: checked.error.path,
        message: checked.error.message,
      };
    }
    this.store(projectKey, checked.value);
    return { status: "drafted", draft: cloneMoveDraft(checked.value) };
  }

  /** Proposes changed fields of one existing phase; shares the one-pending-per-project slot. */
  createEdit(input: RoadmapPhaseEditDraftCreateRequest): RoadmapPhaseEditDraftCreateResult {
    const validated = validateRoadmapPhaseEditRequest(input.request);
    if (!validated.ok) {
      return {
        status: "invalid-proposal",
        path: validated.error.path,
        message: validated.error.message,
      };
    }
    const request = validated.value;
    if (input.phase.id !== request.phaseId) {
      return {
        status: "invalid-proposal",
        path: "phaseId",
        message: "expected the inspected phase to match the requested phase ID",
      };
    }
    const projectKey = canonicalProjectKey(input.cwd);
    const blocking = this.blockingProposal(projectKey, input.sessionId);
    if (blocking) return { status: "proposal-pending", draft: blocking };
    const reason = classifyRoadmapPhaseEditability(input.phase);
    if (reason !== null) {
      return { status: "phase-not-editable", phaseId: request.phaseId, reason };
    }
    const changes = buildRoadmapPhaseEditChanges(input.phase, request);
    if (changes.length === 0) return { status: "no-changes", phaseId: request.phaseId };

    const candidate: RoadmapPhaseEditDraft = {
      kind: "edit",
      id: this.createId(),
      projectKey,
      basedOnRevision: request.expectedRevision,
      createdAt: this.now(),
      createdBySessionId: input.sessionId,
      summary: request.summary,
      phaseId: request.phaseId,
      phaseTitle: input.phase.title,
      basedOnUpdatedAt: input.phase.updatedAt,
      changes,
      status: "pending",
    };
    const checked = validateRoadmapPhaseEditDraft(candidate);
    if (!checked.ok) {
      return {
        status: "invalid-proposal",
        path: checked.error.path,
        message: checked.error.message,
      };
    }
    this.store(projectKey, checked.value);
    return { status: "drafted", draft: cloneEditDraft(checked.value) };
  }

  /**
   * The pending proposal that keeps a new one out, re-announced for a missed
   * notification. The creating session may revise its own proposal in place
   * (like a resubmitted plan), unless an approval of it is already in flight;
   * another session's proposal is never replaced.
   */
  private blockingProposal(projectKey: string, sessionId: string): RoadmapPhaseDraft | null {
    const existing = this.pendingByProject.get(projectKey);
    if (!existing) return null;
    if (existing.createdBySessionId === sessionId && !this.approvals.has(existing.id)) return null;
    this.emit(projectKey, existing);
    return cloneDraft(existing);
  }

  private store(projectKey: string, draft: RoadmapPhaseDraft): void {
    // A revision supersedes the creator's earlier proposal; its ID becomes unknown.
    const superseded = this.pendingByProject.get(projectKey);
    if (superseded && superseded.id !== draft.id) this.projectByDraftId.delete(superseded.id);
    this.pendingByProject.set(projectKey, draft);
    this.projectByDraftId.set(draft.id, projectKey);
    this.emit(projectKey, draft);
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
    if (result.status === "created" || result.status === "edited" || result.status === "moved") {
      this.removePending(draft);
      this.rememberDecision(draft.id, { projectKey, decision: "approved", result });
      this.emit(projectKey, null);
    } else if (
      result.status === "stale-revision" ||
      result.status === "phase-changed" ||
      result.status === "phase-not-editable"
    ) {
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
  if (decision.decision !== "approved") return { status: "already-decided", decision: "rejected" };
  return decision.result.status === "created"
    ? { ...decision.result, phaseIds: [...decision.result.phaseIds] }
    : { ...decision.result };
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
  if (isRoadmapPhaseEditDraft(draft)) return cloneEditDraft(draft);
  return isRoadmapPhaseMoveDraft(draft) ? cloneMoveDraft(draft) : cloneCreateDraft(draft);
}

function cloneOrderPreview(preview: RoadmapPhaseOrderPreview): RoadmapPhaseOrderPreview {
  return {
    before: preview.before.map((entry) => ({ ...entry })),
    after: preview.after.map((entry) => ({ ...entry })),
  };
}

function cloneMoveDraft(draft: RoadmapPhaseMoveDraft): RoadmapPhaseMoveDraft {
  return { ...draft, orderPreview: cloneOrderPreview(draft.orderPreview) };
}

function cloneEditDraft(draft: RoadmapPhaseEditDraft): RoadmapPhaseEditDraft {
  return {
    ...draft,
    changes: draft.changes.map((change) =>
      change.field === "doneWhen"
        ? { ...change, before: [...change.before], after: [...change.after] }
        : { ...change },
    ),
  };
}

function cloneCreateDraft(draft: RoadmapPhaseCreateDraft): RoadmapPhaseCreateDraft {
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
    ...(draft.orderPreview ? { orderPreview: cloneOrderPreview(draft.orderPreview) } : {}),
  };
}
