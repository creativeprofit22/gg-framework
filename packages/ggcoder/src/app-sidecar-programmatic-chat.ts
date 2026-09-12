import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  isProgrammaticChatRequest,
  isProgrammaticChatResponse,
  type ProgrammaticChatResponse,
  type ProgrammaticChatProposal,
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
  private disposed = false;
  constructor(
    private readonly target: () => ProgrammaticChatTarget,
    private readonly claim: () => boolean,
    private readonly release: () => void,
    private readonly implementations = engines,
  ) {}

  reset(): void {
    this.pending = null;
    this.epoch++;
  }
  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  async handle(
    input: unknown,
  ): Promise<{ status: number; body: ProgrammaticChatResponse | { error: string } }> {
    if (!isProgrammaticChatRequest(input))
      return { status: 400, body: { error: "This opportunity request could not be read. Reopen Opportunities and try again." } };
    const { action } = input;
    const target = this.target();
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
    const mutates = ["approve-setup", "scan", "dismiss"].includes(action);
    if (mutates && target.planMode) return fail(403, "Plan mode only allows review. Turn it off before making changes.");
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
        (!mutates || !now.planMode)
      );
    };
    let submitted = false;
    try {
      if (!(await stat(target.cwd)).isDirectory())
        return fail(409, "The project folder cannot be read. Check that it is still available.");
      if (!current()) return fail(409, "The project or chat changed. Reopen Opportunities to load its results.");
      let body: ProgrammaticChatResponse;
      switch (input.action) {
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
          const proposal = await this.implementations.inspect(target.cwd);
          if (!current()) return fail(409, "The project or chat changed. Choose Review setup again.");
          const handle = sha256(randomBytes(32).toString("hex") + canonicalJson(proposal));
          const projection: ProgrammaticChatProposal = {
            handle,
            fingerprint: proposal.configurationFingerprint.sha256,
            profileJson: canonicalJson(proposal.profile),
            routes: proposal.routes.map(({ opportunityId, resolution }) => ({
              id: opportunityId,
              route: {
                available: resolution.status === "routable",
                command:
                  resolution.status === "routable"
                    ? resolution.specialistCommand
                    : (resolution.candidateCommand ?? null),
                reason: resolution.reason,
                machineLocal: resolution.availability.portability === "machine-local",
              },
            })),
            exclusions: proposal.exclusions,
            configurationInputs: proposal.configurationInputs,
          };
          body = { version: 1, action: "inspect-setup", ok: true, proposal: projection };
          if (!isProgrammaticChatResponse(body))
            return fail(422, "The proposed setup is too large to display safely. It cannot be approved here; no settings were saved.");
          this.pending = { identity: target.identity, cwd: target.cwd, handle, proposal };
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
          );
          if (!result.ok)
            return fail(409, "The project settings changed. Choose Review setup to see the new settings before approving.");
          body = { version: 1, action: "approve-setup", ok: true, changed: result.changed };
          break;
        }
        case "scan": {
          submitted = true;
          const result = await this.implementations.scan(target.cwd);
          if (!result.ok)
            return fail(
              409,
              result.changed
                ? result.detail
                : "The checks did not finish. Reload results before trying again.",
              true,
            );
          body = { version: 1, action: "scan", ok: true, changed: result.changed };
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
    }
  }
}
