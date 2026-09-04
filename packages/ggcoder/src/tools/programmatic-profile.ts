import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  configurationFingerprintV1Schema,
  programmaticProfileV1Schema,
} from "../core/programmatic/contracts.js";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
} from "../core/programmatic/profile.js";
import { PROGRAMMATIC_PROFILE_PATH } from "../core/programmatic/inventory.js";
import { containedPath, stableJson } from "../core/tauri-package/paths.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";

const InspectParams = z.strictObject({ action: z.literal("inspect") });
const GenerateParams = z.strictObject({
  action: z.literal("generate"),
  configuration_fingerprint: configurationFingerprintV1Schema,
  profile: programmaticProfileV1Schema,
});

export const ProgrammaticProfileParams = z.discriminatedUnion("action", [
  InspectParams,
  GenerateParams,
]);

export interface ProgrammaticProfileToolOptions {
  localFilesystem?: boolean;
  planModeRef?: { current: boolean };
  onPreFileMutation?: (absolutePath: string) => Promise<void> | void;
  onFileMutated?: (absolutePath: string) => Promise<void> | void;
}

export function createProgrammaticProfileTool(
  cwd: string,
  options: ProgrammaticProfileToolOptions = {},
): AgentTool<typeof ProgrammaticProfileParams> {
  return {
    name: "programmatic_profile",
    description:
      "Inspect a deterministic programmatic scanner-profile proposal, or persist that exact " +
      "validated proposal after separate approval. Uses one fixed repository path and never runs scanners, specialists, or commands.",
    parameters: ProgrammaticProfileParams,
    executionMode: "sequential",
    async execute(input) {
      if (options.localFilesystem === false) {
        return stableJson({
          action: input.action,
          error: "local-filesystem-required",
          changed: false,
        });
      }
      if (input.action === "generate" && isPlanModeActive(options.planModeRef)) {
        return planModeRestriction("programmatic_profile");
      }

      try {
        if (input.action === "inspect") {
          const proposal = await buildProgrammaticProfileProposal(cwd);
          return stableJson({
            action: "inspect",
            changed: false,
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

        const result = await persistProgrammaticProfile(
          cwd,
          input.configuration_fingerprint,
          input.profile,
          {
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
