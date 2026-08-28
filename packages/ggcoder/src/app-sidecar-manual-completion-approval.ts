import { randomUUID } from "node:crypto";
import type {
  ManualCompletionApprovalCommitOutcome,
  ManualCompletionApprovalCommitRequest,
  ManualCompletionApprovalPreviewOutcome,
  ManualCompletionApprovalPreviewRequest,
} from "@kenkaiiii/gg-core/manual-completion-approval-protocol";
import type { NotesSessionLink, ProjectNotesSnapshot } from "@kenkaiiii/gg-core/project-notes";
import { publishCommittedNotesSnapshot } from "./app-sidecar-committed-notes.js";
import type {
  ProjectNotesManualApprovalPreviewOutcome,
  ProjectNotesRepository,
} from "./project-notes-repository.js";

export interface ManualCompletionApprovalSession {
  getState(): { cwd: string; sessionId: string; sessionPath: string | null };
}

export interface ManualCompletionApprovalService {
  preview(
    request: ManualCompletionApprovalPreviewRequest,
    session: ManualCompletionApprovalSession,
  ): Promise<ManualCompletionApprovalPreviewOutcome>;
  commit(
    request: ManualCompletionApprovalCommitRequest,
  ): Promise<ManualCompletionApprovalCommitOutcome>;
}

export interface ManualCompletionApprovalServiceOptions {
  repository: Pick<
    ProjectNotesRepository,
    "load" | "previewManualCompletionApproval" | "commitManualCompletionApproval"
  >;
  onCommittedSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
  now?: () => number;
  idFactory?: () => string;
  ttlMs?: number;
  maximumCheckpoints?: number;
}

interface StoredCheckpoint {
  cwd: string;
  approvalId: string;
  checkpoint: Extract<ManualCompletionApprovalPreviewOutcome, { status: "ready" }>["checkpoint"];
}

export function createManualCompletionApprovalService(
  options: ManualCompletionApprovalServiceOptions,
): ManualCompletionApprovalService {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const maximumCheckpoints = options.maximumCheckpoints ?? 100;
  const checkpoints = new Map<string, StoredCheckpoint>();

  const prune = (): void => {
    const current = now();
    for (const [nonce, stored] of checkpoints) {
      if (Date.parse(stored.checkpoint.expiresAt) <= current) checkpoints.delete(nonce);
    }
    while (checkpoints.size >= maximumCheckpoints) {
      const oldest = checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      checkpoints.delete(oldest);
    }
  };

  return {
    async preview(request, session) {
      prune();
      const state = session.getState();
      const expectedSession: NotesSessionLink = {
        sessionId: state.sessionId,
        sessionPath: state.sessionPath,
      };
      if (!state.sessionPath) {
        return { status: "unmet-gate", revision: request.expectedRevision, code: "stale-session" };
      }
      const outcome = await options.repository.previewManualCompletionApproval(
        state.cwd,
        request.phaseId,
        request.expectedRevision,
        expectedSession,
      );
      if (outcome.status !== "ready") return publicPreviewOutcome(outcome);
      const nonce = idFactory();
      const expiresAt = new Date(now() + ttlMs).toISOString();
      const checkpoint = {
        nonce,
        projectKey: outcome.projectKey,
        phaseId: outcome.phaseId,
        revision: outcome.revision,
        session: outcome.session,
        implementationCheckpointId: outcome.implementationCheckpointId,
        verificationStatusUpdateId: outcome.verificationStatusUpdateId,
        expiresAt,
      };
      checkpoints.set(nonce, {
        cwd: state.cwd,
        approvalId: `manual-approval-${nonce}`,
        checkpoint,
      });
      return { status: "ready", checkpoint };
    },

    async commit(request) {
      const stored = checkpoints.get(request.nonce);
      if (!stored) return { status: "nonce-not-found" };
      if (Date.parse(stored.checkpoint.expiresAt) <= now()) {
        checkpoints.delete(request.nonce);
        return { status: "nonce-expired" };
      }
      const outcome = await options.repository.commitManualCompletionApproval(stored.cwd, {
        phaseId: stored.checkpoint.phaseId,
        expectedRevision: stored.checkpoint.revision,
        expectedSession: stored.checkpoint.session,
        implementationCheckpointId: stored.checkpoint.implementationCheckpointId,
        verificationStatusUpdateId: stored.checkpoint.verificationStatusUpdateId,
        approvalId: stored.approvalId,
        timestamp: new Date(now()).toISOString(),
      });
      checkpoints.delete(request.nonce);
      if (outcome.status === "committed") {
        await publishCommittedNotesSnapshot(
          options.repository,
          stored.cwd,
          outcome.revision,
          options.onCommittedSnapshot,
        );
      }
      return outcome;
    },
  };
}

function publicPreviewOutcome(
  outcome: Exclude<ProjectNotesManualApprovalPreviewOutcome, { status: "ready" }>,
): Exclude<ManualCompletionApprovalPreviewOutcome, { status: "ready" }> {
  return outcome;
}
