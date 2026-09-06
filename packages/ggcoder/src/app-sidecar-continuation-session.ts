import { randomUUID } from "node:crypto";
import { captureContinuationReviewEvidence, continuationReviewSchema, type ContinuationReviewEvidence } from "./core/continuation-review-context.js";
import type {
  ContinuationAcceptedEvent,
  ContinuationCommitRequest,
  ContinuationCommitResponse,
  ContinuationDestination,
  ContinuationPrepareResponse,
  ContinuationSourceRevision,
} from "@kenkaiiii/gg-core/desktop-session-ux";
import type { AgentSession } from "./core/agent-session.js";
import type { RunClaim } from "./core/run-claim.js";
import { CONTINUATION_HANDOFF_LIMITS } from "./core/continuation-handoff.js";
import { isOpenAICodexAstraSession } from "./app-sidecar-context-profile.js";
import type { AppSidecarSessionMutationCoordinator, SessionMutationOwner } from "./app-sidecar-session-mutation.js";

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 8;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function parseContinuationCommitRequest(body: unknown): ContinuationCommitRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["preparedId", "operationId", "profile"].includes(key)) ||
      typeof value.preparedId !== "string" || !ID.test(value.preparedId) ||
      typeof value.operationId !== "string" || !ID.test(value.operationId) ||
      (value.profile !== undefined && value.profile !== "stable" && value.profile !== "experimental")) return null;
  return { preparedId: value.preparedId, operationId: value.operationId, ...(value.profile ? { profile: value.profile } : {}) };
}

export interface ContinuationCommitResult {
  status: 200 | 400 | 409 | 500;
  body: ContinuationCommitResponse;
}

type Session = Pick<AgentSession,
  "getState" | "getConversationIdentity" | "getContinuationSourceRevision" | "switchOpenAICodexContextProfile" |
  "getMessages" | "getApprovedPlanConsumption" | "getContinuationReviewRecord" | "persistRequiredAppMarker">;

interface Entry {
  source: ContinuationSourceRevision;
  nextInstruction: string;
  evidence: ContinuationReviewEvidence;
  sourceProfile: "stable" | "experimental";
  expiresAt: number;
  prompt?: string;
  state: "preparing" | "prepared" | "committing" | "terminal";
  request?: ContinuationCommitRequest;
  result?: ContinuationCommitResult;
}

export interface ContinuationSessionDependencies {
  session: Session;
  mutations: AppSidecarSessionMutationCoordinator;
  runClaim: RunClaim;
  busy(): boolean;
  prepare(nextInstruction: string): Promise<{ prompt: string }>;
  reset(owner: SessionMutationOwner): Promise<void>;
  /** The promise spans generation, but onAccepted runs after required append. */
  prompt(prompt: string, onAccepted: () => Promise<void>): Promise<void>;
  accepted(event: ContinuationAcceptedEvent): void;
  now?: () => number;
}

/** One instance per logical pane session. No client envelope or source authority is trusted. */
export class AppSidecarContinuationSession {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly deps: ContinuationSessionDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      // Never evict live work: even expired preparations count toward the cap.
      if (entry.expiresAt <= this.now() && entry.state !== "committing" && entry.state !== "preparing") {
        this.entries.delete(id);
      }
    }
  }

  async prepare(nextInstruction: string): Promise<ContinuationPrepareResponse> {
    if (!nextInstruction.trim() || nextInstruction.length > CONTINUATION_HANDOFF_LIMITS.nextInstructionChars) {
      throw new Error("Invalid continuation instruction.");
    }
    this.prune();
    if (this.entries.size >= MAX_ENTRIES) throw new Error("Too many prepared continuations. Wait for expiry before preparing another.");
    if (this.deps.busy() || this.deps.runClaim.active || this.deps.mutations.owner) {
      throw new Error("Session is busy. Retry preparation when idle.");
    }
    const preparedId = randomUUID();
    const entry: Entry = {
      source: this.deps.session.getContinuationSourceRevision(),
      nextInstruction,
      evidence: captureContinuationReviewEvidence(
        this.deps.session.getMessages(), this.deps.session.getConversationIdentity(),
        this.deps.session.getApprovedPlanConsumption(), this.deps.session.getContinuationReviewRecord(),
      ),
      sourceProfile: this.deps.session.getState().openAICodexContextProfile,
      expiresAt: this.now() + TTL_MS,
      state: "preparing",
    };
    this.entries.set(preparedId, entry);
    try {
      const prepared = await this.deps.prepare(nextInstruction);
      if (entry.expiresAt <= this.now() || !this.matchesSource(entry)) {
        throw new Error("Source changed or preparation expired. Prepare again; nothing was reset.");
      }
      entry.prompt = prepared.prompt;
      entry.state = "prepared";
      return { version: 1, preparedId, source: { ...entry.source }, expiresAt: entry.expiresAt, prompt: prepared.prompt };
    } catch (error) {
      this.entries.delete(preparedId);
      throw error;
    }
  }

  private matchesSource(entry: Entry): boolean {
    return JSON.stringify(entry.source) === JSON.stringify(this.deps.session.getContinuationSourceRevision());
  }

  commit(request: ContinuationCommitRequest): Promise<ContinuationCommitResult> {
    this.prune();
    const base = { operationId: request.operationId, preparedId: request.preparedId };
    const reject = (error: string, message: string): Promise<ContinuationCommitResult> => Promise.resolve({
      status: 409, body: { ...base, outcome: "rejected", accepted: false, resetAttempted: false, error, message },
    });
    const entry = this.entries.get(request.preparedId);
    if (!entry) return Promise.resolve({ status: 409, body: {
      ...base, outcome: "outcome-unknown", accepted: null, resetAttempted: false,
      error: "continuation_unknown", message: "Prepared continuation is unknown or expired. Inspect the current session; do not automatically reset or resend.",
    } });
    // An operation ID is scoped to exactly one prepared payload in this pane.
    for (const other of this.entries.values()) {
      if (other !== entry && other.request?.operationId === request.operationId) {
        return reject("continuation_operation_mismatch", "This operation belongs to another prepared continuation.");
      }
    }
    if (entry.request) {
      if (entry.request.operationId !== request.operationId || entry.request.profile !== request.profile) {
        return reject("continuation_operation_mismatch", "Prepared continuation was already consumed by a different operation or profile.");
      }
      if (entry.result) return Promise.resolve(structuredClone(entry.result));
      return Promise.resolve({ status: 409, body: {
        ...base, outcome: "outcome-unknown", accepted: null, resetAttempted: true,
        error: "continuation_in_progress", message: "This operation is still in progress. Retry only this same operation; do not reset or resend.",
      } });
    }
    if (entry.state !== "prepared" || !entry.prompt) return reject("continuation_not_ready", "Preparation is not ready.");
    if (this.deps.busy() || this.deps.runClaim.active) return reject("session_busy", "Wait for the current session operation to finish.");
    const lease = this.deps.mutations.tryAcquire("continuation-commit");
    if (!lease) return reject("session_mutation_in_progress", "Another session startup operation owns this session.");
    const claimed = this.deps.runClaim.claim();
    if (!claimed) {
      lease.release();
      return reject("session_busy", "Another run owns this session.");
    }
    entry.request = { ...request };
    entry.state = "committing";
    const selectedProfile = request.profile ?? this.deps.session.getState().openAICodexContextProfile;
    const recovery = { ...base, selectedProfile, recoveryPrompt: entry.prompt };
    let resetAttempted = false;
    let promptAttempted = false;
    let destination: ContinuationDestination | undefined;
    let resolve!: (result: ContinuationCommitResult) => void;
    const response = new Promise<ContinuationCommitResult>((done) => { resolve = done; });
    const finish = (result: ContinuationCommitResult) => {
      entry.result = structuredClone(result);
      entry.state = "terminal";
      resolve(result);
    };
    // Starts synchronously under both owners; only the response ends at acceptance.
    void (async () => {
      try {
        if (!this.matchesSource(entry)) throw new Error("Source changed. Prepare again; nothing was reset.");
        if (request.profile && !isOpenAICodexAstraSession(this.deps.session.getState())) {
          throw new Error("Destination context mode applies only to Astra through Codex OAuth.");
        }
        resetAttempted = true;
        await this.deps.reset({ operationId: request.operationId, kind: "continuation-commit" });
        const identity = this.deps.session.getConversationIdentity();
        if (identity.conversationId === entry.source.conversationId || !identity.conversationId || !identity.sessionId) {
          throw new Error("Reset did not establish a fresh destination.");
        }
        destination = { conversationId: identity.conversationId, sessionId: identity.sessionId, profile: this.deps.session.getState().openAICodexContextProfile };
        if (request.profile) {
          if (!isOpenAICodexAstraSession(this.deps.session.getState())) throw new Error("Destination model changed during reset.");
          await this.deps.session.switchOpenAICodexContextProfile(request.profile);
        }
        destination.profile = this.deps.session.getState().openAICodexContextProfile;
        if (destination.profile !== selectedProfile) {
          throw new Error("Destination context mode does not match the selected mode.");
        }
        promptAttempted = true;
        await this.deps.prompt(entry.prompt!, async () => {
          const accepted = this.deps.session.getConversationIdentity();
          if (accepted.conversationId !== destination!.conversationId || accepted.sessionId !== destination!.sessionId ||
              this.deps.session.getState().openAICodexContextProfile !== destination!.profile || !accepted.leafId) {
            throw new Error("Destination identity changed at acceptance. Inspect the session before recovery.");
          }
          const record = continuationReviewSchema.parse({
            version: 1, source: entry.source, sourceProfile: entry.sourceProfile,
            destination: { ...destination! }, preparedId: request.preparedId, operationId: request.operationId,
            acceptedMessageId: accepted.leafId, instruction: entry.nextInstruction, ...entry.evidence,
          });
          await this.deps.session.persistRequiredAppMarker("user_hint", { kenSent: true, continuationReview: record });
          const afterPersist = this.deps.session.getConversationIdentity();
          if (afterPersist.conversationId !== destination!.conversationId ||
              this.deps.session.getState().openAICodexContextProfile !== destination!.profile) {
            throw new Error("Destination changed during required reviewer record persistence.");
          }
          const result: ContinuationCommitResult = { status: 200, body: {
            ...recovery, outcome: "accepted", accepted: true, resetAttempted: true,
            destination: { ...destination! }, acceptedMessageId: accepted.leafId,
          } };
          // Cache before publishing. A retry never emits another user bubble.
          finish(result);
          try {
            this.deps.accepted({ ...base, destination: { ...destination! }, acceptedMessageId: accepted.leafId, prompt: entry.prompt!, kenSent: true });
          } finally {
            lease.release();
          }
        });
        if (!entry.result) throw new Error("Prompt returned without an acceptance receipt.");
      } catch (error) {
        if (!entry.result) {
          if (resetAttempted) {
            const actual = this.deps.session.getConversationIdentity();
            if (actual.conversationId !== entry.source.conversationId) {
              destination = { conversationId: actual.conversationId, sessionId: actual.sessionId, profile: this.deps.session.getState().openAICodexContextProfile };
            }
          }
          const message = error instanceof Error ? error.message : String(error);
          finish({ status: resetAttempted ? 500 : 409, body: resetAttempted
            ? { ...recovery, outcome: "partial", accepted: promptAttempted ? null : false, resetAttempted: true, destination,
                error: "continuation_partial", message: `Reset was attempted. ${message} Inspect the destination before manually recovering the prepared text.` }
            : { ...recovery, outcome: "rejected", accepted: false, resetAttempted: false, error: "continuation_rejected", message },
          });
        }
      } finally {
        lease.release();
        if (claimed) this.deps.runClaim.release();
      }
    })();
    return response;
  }
}
