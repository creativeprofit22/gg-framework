import type { ProgrammaticChatProposal } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type { ProgrammaticProfileProposalV1 } from "./core/programmatic/profile.js";
import { canonicalJson } from "./core/tauri-package/paths.js";

/** Pure display projection. Approval ownership and handles remain in the adapter. */
export function projectProgrammaticSetup(proposal: ProgrammaticProfileProposalV1, handle: string): ProgrammaticChatProposal {
  return {
    handle: proposal.operation === "current" ? null : handle,
    operation: proposal.operation,
    configuration: proposal.configuration,
    fingerprint: proposal.configurationFingerprint.sha256,
    profileJson: canonicalJson(proposal.profile),
    ...(proposal.historyPolicy ? { historyPolicy: proposal.historyPolicy, expectedRecoveryDigest: proposal.expectedRecoveryDigest } : {}),
    routes: proposal.routes.map(({ opportunityId, resolution }) => ({
      id: opportunityId,
      route: {
        available: resolution.status === "routable",
        command: resolution.status === "routable" ? resolution.specialistCommand : (resolution.candidateCommand ?? null),
        reason: resolution.reason,
        machineLocal: resolution.availability.portability === "machine-local",
      },
    })),
    exclusions: proposal.exclusions,
    configurationInputs: proposal.configurationInputs,
  };
}
