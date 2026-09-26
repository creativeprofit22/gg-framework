import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { CommandCreationReviewer } from "./command-creation.js";
import type { ProgrammaticProfileProposalV1, PersistProgrammaticProfileOptions } from "./profile.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./profile.js";
import { canonicalRepositoryRoot, stableJson } from "../tauri-package/paths.js";

interface PendingSetup {
  proposal: ProgrammaticProfileProposalV1;
  identity: string;
  owner: string;
}

/** Session-local proposal and human answer; neither fingerprints nor model text grant consent. */
export class ProgrammaticSetupReview {
  private pending?: PendingSetup;
  private active?: AbortController;
  private epoch = 0;
  private disposed = false;
  constructor(private readonly options: {
    cwd: string;
    reviewer?: CommandCreationReviewer;
    owner: () => string;
    assertAllowed: () => void;
  }) {}

  cancel(): void {
    this.epoch++;
    this.pending = undefined;
    this.active?.abort();
    this.active = undefined;
  }
  dispose(): void { this.disposed = true; this.cancel(); }

  private async identity(): Promise<string> {
    const root = await canonicalRepositoryRoot(this.options.cwd);
    const info = await stat(root);
    return stableJson({ root, dev: info.dev, ino: info.ino });
  }

  async inspect(signal: AbortSignal): Promise<ProgrammaticProfileProposalV1> {
    this.cancel();
    const epoch = this.epoch;
    const owner = this.options.owner();
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Setup review is disposed.");
    const identity = await this.identity();
    const proposal = await buildProgrammaticProfileProposal(this.options.cwd, { offerHistory: true });
    const currentIdentity = await this.identity();
    signal.throwIfAborted();
    if (this.disposed || epoch !== this.epoch || owner !== this.options.owner() || identity !== currentIdentity)
      throw new Error("Setup inspection owner changed; inspect again.");
    if (proposal.operation !== "current") {
      this.pending = { proposal, identity, owner };
    }
    return proposal;
  }

  async generate(input: {
    configuration_fingerprint: ProgrammaticProfileProposalV1["configurationFingerprint"];
    profile: ProgrammaticProfileProposalV1["profile"];
    expected_prior_profile_digest: string | null;
  }, signal: AbortSignal, persistence: PersistProgrammaticProfileOptions) {
    // Claim synchronously, before review or any filesystem await. A failed attempt consumes it too.
    const pending = this.pending;
    this.cancel();
    const epoch = this.epoch;
    const unavailable = (error: string) => ({ ok: false, changed: false, error });
    if (!this.options.reviewer) return { ...unavailable("unsupported-host"), message: "Setup approval transport is unavailable in this host. Use the native setup review or a host with setup approval support." };
    if (!pending || this.disposed) return unavailable("setup-proposal-unavailable: inspect again before review");
    if (stableJson(input.configuration_fingerprint) !== stableJson(pending.proposal.configurationFingerprint))
      return unavailable("stale-proposal");
    if (stableJson(input.profile) !== stableJson(pending.proposal.profile)) return unavailable("proposal-mismatch");
    if (input.expected_prior_profile_digest !== pending.proposal.expectedPriorProfileDigest)
      return unavailable("prior-profile-mismatch");
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const assertCurrent = () => {
      signal.throwIfAborted();
      controller.signal.throwIfAborted();
      if (this.disposed || epoch !== this.epoch || pending.owner !== this.options.owner())
        throw new Error("Setup approval owner changed; inspect again.");
      this.options.assertAllowed();
    };
    const revalidate = async () => {
      assertCurrent();
      if (pending.identity !== await this.identity()) throw new Error("Setup project changed; inspect again.");
      const current = await buildProgrammaticProfileProposal(this.options.cwd, { offerHistory: true });
      const bound = (proposal: ProgrammaticProfileProposalV1) => ({
        configuration: proposal.configurationFingerprint, profile: proposal.profile,
        prior: proposal.expectedPriorProfileDigest, snapshot: proposal.configurationSnapshot,
        routes: proposal.routes, historyPolicy: proposal.historyPolicy, recovery: proposal.expectedRecoveryDigest,
      });
      if (stableJson(bound(current)) !== stableJson(bound(pending.proposal)))
        throw new Error("Setup changed since inspection; inspect and review again.");
      assertCurrent();
    };
    try {
      await revalidate();
      const id = `setup-review-${randomUUID()}`;
      // Review the exact saved settings and configuration baseline, not the unrelated source inventory.
      const preview = JSON.stringify({
        operation: pending.proposal.operation,
        configurationFingerprint: pending.proposal.configurationFingerprint,
        configurationSnapshot: pending.proposal.configurationSnapshot,
        configuration: pending.proposal.configuration,
        profile: pending.proposal.profile,
        expectedPriorProfileDigest: pending.proposal.expectedPriorProfileDigest,
        routes: pending.proposal.routes,
        historyPolicy: pending.proposal.historyPolicy,
        expectedRecoveryDigest: pending.proposal.expectedRecoveryDigest,
      }, null, 2);
      if (Buffer.byteLength(preview, "utf8") > 64_000) throw new Error("Setup review is too large; approval is unavailable.");
      const response = await this.options.reviewer({ questions: [{
        id, kind: "choice", question: "Save these exact programmatic settings?",
        detail: `This saves setup only. History saving, when shown as enabled below, automatically saves future configured assessments; it does not save this setup assessment or import old transcripts. Existing settings remain usable if you decline the history upgrade. It does not scan, create commands, or approve command execution. Configuration and prior-file digests are change guards, not consent.\n\n${preview}`,
        allowOther: false, options: [
          { label: "Save reviewed setup", value: "save-setup", recommended: true },
          { label: "Do not save", value: "deny" },
        ],
      }] }, controller.signal);
      assertCurrent();
      if (response.action !== "answer" || response.answers[id] !== "save-setup")
        return unavailable("setup-approval-denied");
      await revalidate();
      return await persistProgrammaticProfile(this.options.cwd, pending.proposal.configurationFingerprint,
        pending.proposal.profile, {
          ...persistence, signal: controller.signal,
          expectedPriorProfileDigest: pending.proposal.expectedPriorProfileDigest,
          historyPolicy: pending.proposal.historyPolicy,
          expectedRecoveryDigest: pending.proposal.expectedRecoveryDigest,
          onPreMutation: async (file) => { await persistence.onPreMutation?.(file); assertCurrent(); },
          validateBeforeCommit: async () => {
            if (pending.identity !== await this.identity()) throw new Error("Setup project changed before commit.");
            assertCurrent();
          },
        });
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.active === controller) this.active = undefined;
    }
  }
}
