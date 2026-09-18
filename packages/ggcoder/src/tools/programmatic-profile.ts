import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ASK_USER_TIMEOUT_MS } from "../core/ask-user.js";
import {
  configurationFingerprintV1Schema,
  programmaticProfileV1Schema,
} from "../core/programmatic/contracts.js";
import { ProgrammaticSetupReview } from "../core/programmatic/setup-review.js";
import type { CommandCreationReviewer } from "../core/programmatic/command-creation.js";
import { PROGRAMMATIC_PROFILE_PATH } from "../core/programmatic/inventory.js";
import { containedPath, stableJson } from "../core/tauri-package/paths.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";

const InspectParams = z.strictObject({ action: z.literal("inspect") });
const GenerateParams = z.strictObject({
  action: z.literal("generate"),
  configuration_fingerprint: configurationFingerprintV1Schema,
  profile: programmaticProfileV1Schema,
  expected_prior_profile_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

export const ProgrammaticProfileParams = z.discriminatedUnion("action", [
  InspectParams,
  GenerateParams,
]);

export interface ProgrammaticProfileToolOptions {
  reviewer?: CommandCreationReviewer;
  owner?: () => string;
  assertAllowed?: () => void;
  localFilesystem?: boolean;
  planModeRef?: { current: boolean };
  onPreFileMutation?: (absolutePath: string) => Promise<void> | void;
  onFileMutated?: (absolutePath: string) => Promise<void> | void;
}

export function createProgrammaticProfileTool(
  cwd: string,
  options: ProgrammaticProfileToolOptions = {},
): AgentTool<typeof ProgrammaticProfileParams> & { cancel(): void; dispose(): void } {
  const review = new ProgrammaticSetupReview({ cwd, reviewer: options.reviewer,
    owner: options.owner ?? (() => cwd), assertAllowed: () => {
      if (options.localFilesystem === false || isPlanModeActive(options.planModeRef))
        throw new Error("Setup generation is unavailable under the current host policy.");
      options.assertAllowed?.();
    },
  });
  return {
    cancel: () => review.cancel(),
    dispose: () => review.dispose(),
    name: "programmatic_profile",
    description:
      "Inspect a deterministic programmatic scanner-profile proposal, or persist that exact " +
      "validated proposal after separate approval. Uses one fixed repository path and never runs scanners, specialists, or commands.",
    parameters: ProgrammaticProfileParams,
    executionMode: "sequential",
    // Match ask_user: the question owner expires review before the tool deadline.
    timeoutMs: ASK_USER_TIMEOUT_MS + 30_000,
    async execute(input, context) {
      if (options.localFilesystem === false) {
        return stableJson({
          action: input.action,
          error: "local-filesystem-required",
          changed: false,
        });
      }
      if (input.action === "generate" && isPlanModeActive(options.planModeRef)) {
        review.cancel();
        return planModeRestriction("programmatic_profile");
      }

      try {
        if (input.action === "inspect") {
          const proposal = await review.inspect(context.signal);
          return stableJson({
            action: "inspect",
            changed: false,
            operation: proposal.operation,
            approval_available: proposal.operation !== "current" && !!options.reviewer,
            approval_transport: options.reviewer ? "host-review" : "unsupported-host",
            expected_prior_profile_digest: proposal.expectedPriorProfileDigest,
            configuration: proposal.configuration,
            configuration_fingerprint: proposal.configurationFingerprint,
            configuration_inputs: proposal.configurationInputs,
            exclusions: proposal.exclusions,
            inventory: proposal.inventory,
            profile: proposal.profile,
            profile_path: PROGRAMMATIC_PROFILE_PATH,
            routes: proposal.routes.map((route) => ({
              opportunity_id: route.opportunityId,
              detector_id: route.detectorId,
              resolution: route.resolution,
            })),
            summary: "Inspection completed; no files were written.",
          });
        }

        const result = await review.generate(
          input,
          context.signal,
          {
            expectedPriorProfileDigest: input.expected_prior_profile_digest,
            onPreMutation: (repositoryPath) =>
              options.onPreFileMutation?.(containedPath(cwd, repositoryPath)),
            onCommitted: (repositoryPath) =>
              options.onFileMutated?.(containedPath(cwd, repositoryPath)),
          },
        );
        return stableJson({ action: "generate", ...result });
      } catch (error) {
        return stableJson({
          action: input.action,
          changed: false,
          error: "operation-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
