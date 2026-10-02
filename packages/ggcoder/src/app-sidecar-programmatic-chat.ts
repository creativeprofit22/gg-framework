import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { RecommendationHistoryReview } from "./core/programmatic/recommendation-history.js";
import type { AgentSession } from "./core/agent-session.js";
import type { DiscoveryReviewRequest, DiscoveryReview } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { isProgrammaticAssessmentEvent, type ProgrammaticAssessment, type ProgrammaticAssessmentEvent } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import {
  isProgrammaticChatRequest,
  isProgrammaticChatResponse,
  type ProgrammaticChatResponse,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
  type ProgrammaticProfileProposalV1,
} from "./core/programmatic/profile.js";
import {
  readProgrammaticChatReport,
  readProgrammaticChatDetail,
  dismissProgrammaticOpportunity,
  runProgrammaticScan,
} from "./core/programmatic/lifecycle.js";
import { canonicalJson, sha256 } from "./core/tauri-package/paths.js";
import { projectProgrammaticSetup } from "./app-sidecar-programmatic-projection.js";

/** Bind the existing session bus to the desktop broadcast surface. Retired
 * session objects and conversation identities cannot publish current status. */
export function bindProgrammaticAssessmentEvents(
  target: AgentSession,
  currentSession: () => AgentSession,
  broadcast: (event: "programmatic_assessment", data: ProgrammaticAssessmentEvent) => void,
): () => void {
  return target.eventBus.on("programmatic_assessment", (data) => {
    const session = currentSession();
    const current = session.getConversationIdentity();
    if (target !== session || !isProgrammaticAssessmentEvent(data) ||
      data.conversationId !== current.conversationId || data.sessionId !== current.sessionId) return;
    broadcast("programmatic_assessment", data);
  });
}

export type ProgrammaticChatAssessment = (mode: "setup" | "configured", requestId?: string) => ReturnType<AgentSession["assessProgrammatic"]>;

function unavailableAssessment(mode: "setup" | "configured", deterministic: ProgrammaticAssessment["deterministic"]): ProgrammaticAssessment {
  return { version: 1, mode, status: "unavailable", summary: "Needs assessment unavailable; host settings and deterministic results remain independent.",
    limitations: ["No current-session assessment provider is available."], observations: [],
    coverage: [{ scope: "project", status: "uninspected", summary: "Host configuration facts do not establish project understanding." }], deterministic };
}

/** A review appends transcript leaves under the held run claim; those leaves are
 * revisions, not owners. Resets/session changes still invalidate this identity. */
export function programmaticChatIdentity({ conversationId, sessionId }: ReturnType<AgentSession["getConversationIdentity"]>): string {
  return JSON.stringify({ conversationId, sessionId });
}

export interface ProgrammaticChatTarget {
  identity: string;
  cwd: string;
  codeMode: boolean;
  planMode: boolean;
  busy: boolean;
}
const engines = {
  inspect: buildProgrammaticProfileProposal,
  persist: persistProgrammaticProfile,
  report: readProgrammaticChatReport,
  detail: readProgrammaticChatDetail,
  dismiss: dismissProgrammaticOpportunity,
  scan: runProgrammaticScan,
};

/** One instance per authenticated logical session; the webview supplies no executable payload. */
export class AppSidecarProgrammaticChat {
  private pending: {
    identity: string;
    cwd: string;
    handle: string;
    proposal: ProgrammaticProfileProposalV1;
  } | null = null;
  private epoch = 0;
  private readonly history = new RecommendationHistoryReview();
  private disposed = false;
  constructor(
    private readonly target: () => ProgrammaticChatTarget,
    private readonly claim: () => boolean,
    private readonly release: () => void,
    private readonly implementations = engines,
    private readonly onSettled: () => void = () => {},
    private readonly assess?: ProgrammaticChatAssessment,
    private readonly reviewCandidate?: (request: DiscoveryReviewRequest) => Promise<DiscoveryReview>,
  ) {}

  reset(): void {
    this.pending = null;
    this.history.reset();
    this.epoch++;
  }
  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  async handle(
    input: unknown,
  ): Promise<{ status: number; body: ProgrammaticChatResponse | { error: string } }> {
    if (!isProgrammaticChatRequest(input) || Buffer.byteLength(JSON.stringify(input), "utf8") > 2_048)
      return { status: 400, body: { error: "This opportunity request could not be read. Reopen Opportunities and try again." } };
    const { action } = input;
    const target = { ...this.target() };
    const owner = JSON.stringify([target.identity, target.cwd]);
    this.history.setOwner(owner);
    const fail = (status: number, error: string, reconcile = false) => ({
      status,
      body: {
        version: 1 as const, action, ok: false as const, error, reconcile,
        ...(!this.disposed && this.pending &&
          this.pending.identity === target.identity && this.pending.cwd === target.cwd &&
          (input.action === "inspect-setup" ||
            (input.action === "approve-setup" && input.proposalHandle === this.pending.handle))
          ? { approvableProposalHandle: this.pending.handle }
          : {}),
      },
    });
    if (
      this.pending &&
      (this.pending.identity !== target.identity || this.pending.cwd !== target.cwd)
    )
      this.reset();
    if (this.disposed || !target.codeMode)
      return fail(403, "Opportunities are available only in Code mode.");
    const mutates = ["approve-setup", "scan", "dismiss", "history-inspect-decision", "history-inspect-correspondence", "history-apply"].includes(action);
    const requiresCodeMode = mutates || action === "inspect-setup" || action === "discover" || action === "review-candidate";
    if (requiresCodeMode && target.planMode)
      return fail(403, "Plan mode only allows viewing existing results and details. Turn it off before reviewing setup or making changes.");
    // Hold the existing run claim through I/O, preventing prompt/reset/configuration races.
    if (target.busy || !this.claim())
      return fail(409, "Wait for the current work to finish, then try again. This request was not added to a waiting list.");
    const epoch = this.epoch;
    const current = () => {
      const now = this.target();
      return (
        !this.disposed &&
        epoch === this.epoch &&
        now.identity === target.identity &&
        now.cwd === target.cwd &&
        now.codeMode &&
        (!requiresCodeMode || !now.planMode)
      );
    };
    let submitted = false;
    try {
      if (!(await stat(target.cwd)).isDirectory())
        return fail(409, "The project folder cannot be read. Check that it is still available.");
      if (!current()) return fail(409, "The project or chat changed. Reopen Opportunities to load its results.");
      let body: ProgrammaticChatResponse;
      switch (input.action) {
        case "discover": {
          const proposal = await this.implementations.inspect(target.cwd, { offerHistory: true }).catch(() => null);
          if (!current()) return fail(409, "The project or chat changed. Discover opportunities again.");
          const mode = proposal?.configuration.status === "current" ? "configured" : "setup";
          const assessment = this.assess ? (await this.assess(mode, input.requestId)).assessment
            : unavailableAssessment(mode, mode === "setup" ? { status: "not-run", reason: "setup" } : { status: "unavailable", reason: "Assessment provider unavailable." });
          if (!current()) return fail(409, "The project or chat changed. Discover opportunities again.");
          body = { version: 1, action: "discover", ok: true, assessment };
          break;
        }
        case "review-candidate": {
          if (!this.reviewCandidate) return fail(409, "Candidate review is unavailable in this host.");
          const candidateReview = await this.reviewCandidate(input);
          if (!current()) return fail(409, "The project or chat changed. Review was not retained.");
          body = { version: 1, action: "review-candidate", ok: true, candidateReview };
          break;
        }
        case "history-report":
        case "history-detail":
        case "history-inspect-decision":
        case "history-inspect-correspondence":
        case "history-apply": {
          submitted = input.action === "history-apply";
          body = await this.history.handle(input, target.cwd, owner, current);
          break;
        }
        case "report":
          body = {
            version: 1,
            action: "report",
            ok: true,
            report: await this.implementations.report(target.cwd, input.offset),
          };
          break;
        case "detail":
          body = {
            version: 1,
            action: "detail",
            ok: true,
            ...(await this.implementations.detail(target.cwd, input.id)),
          };
          break;
        case "inspect-setup": {
          this.pending = null;
          // A settings failure blocks approval, not the session's safe read-only assessment.
          const proposal = await this.implementations.inspect(target.cwd, { offerHistory: true }).catch(() => null);
          if (!current()) return fail(409, "The project or chat changed. Choose Review setup again.");
          const assessment = this.assess ? (await this.assess("setup", input.requestId)).assessment
            : unavailableAssessment("setup", { status: "not-run", reason: "setup" });
          if (!current()) return fail(409, "The project or chat changed. Choose Review setup again.");
          if (!proposal) {
            const failure = fail(409, "The setup could not be safely reviewed. No settings were saved; approval is unavailable.");
            const body: ProgrammaticChatResponse = { ...failure.body, assessment };
            if (!isProgrammaticChatResponse(body)) return failure;
            return { status: failure.status, body };
          }
          const handle = sha256(randomBytes(32).toString("hex") + canonicalJson(proposal));
          const projection = projectProgrammaticSetup(proposal, handle);
          body = { version: 1, action: "inspect-setup", ok: true, proposal: projection, assessment };
          if (!isProgrammaticChatResponse(body))
            return fail(422, "The proposed setup is too large to display safely. It cannot be approved here; no settings were saved.");
          this.pending = proposal.operation === "current" ? null : { identity: target.identity, cwd: target.cwd, handle, proposal };
          break;
        }
        case "approve-setup": {
          const pending = this.pending;
          this.pending = null;
          if (!pending || pending.handle !== input.proposalHandle)
            return fail(409, "This setup is no longer ready for approval. Choose Review setup again.");
          submitted = true;
          const result = await this.implementations.persist(
            target.cwd,
            pending.proposal.configurationFingerprint,
            pending.proposal.profile,
            { expectedPriorProfileDigest: pending.proposal.expectedPriorProfileDigest,
              historyPolicy: pending.proposal.historyPolicy, expectedRecoveryDigest: pending.proposal.expectedRecoveryDigest,
              validateBeforeCommit: () => { if (!current()) throw new Error("Setup review owner changed."); },
            },
          );
          if (!result.ok)
            return fail(409, result.changed ? result.detail : "The project settings changed. Choose Review setup to see the new settings before approving.", true);
          body = { version: 1, action: "approve-setup", ok: true, changed: result.changed };
          break;
        }
        case "scan": {
          submitted = true;
          if (this.assess) {
            const outcome = await this.assess("configured", input.requestId);
            const facts = outcome.scanFacts;
            const changed = typeof facts === "object" && facts !== null && "changed" in facts && facts.changed === true;
            body = { version: 1, action: "scan", ok: true, changed, assessment: outcome.assessment };
            break;
          }
          const result = await this.implementations.scan(target.cwd);
          if (!result.ok)
            return fail(
              409,
              result.changed
                ? result.detail
                : "The checks did not finish. Reload results before trying again.",
              true,
            );
          body = { version: 1, action: "scan", ok: true, changed: result.changed,
            assessment: unavailableAssessment("configured", result.scanCounts ? { status: "succeeded", ...result.scanCounts } : { status: "unavailable", reason: "Host scan completed without authoritative enabled/applicable counts." }) };
          break;
        }
        case "dismiss": {
          submitted = true;
          body = {
            version: 1,
            action: "dismiss",
            ok: true,
            ...(await this.implementations.dismiss(target.cwd, input.id, input.snapshot)),
          };
          break;
        }
      }
      if (!current())
        return fail(
          409,
          "The project or chat changed. Reload results before continuing.",
          submitted,
        );
      if (!isProgrammaticChatResponse(body))
        return fail(500, "The opportunity results could not be displayed. Reload results before continuing.", submitted);
      return { status: 200, body };
    } catch {
      return fail(
        409,
        submitted
          ? "We could not confirm whether your change was saved. Reload results before trying again."
          : "The project could not be checked. Make sure its folder is available, then try again.",
        submitted,
      );
    } finally {
      this.release();
      // These short I/O owners can receive queued prompts without a provider
      // turn to drain them. Hand off only after releasing exclusive ownership.
      this.onSettled();
    }
  }
}
