import { z } from "zod";
import { directCommandSelectionV1Schema } from "../core/programmatic/contracts.js";
import type { DirectCommandExecutor } from "../core/programmatic/execution.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ASK_USER_TIMEOUT_MS } from "../core/ask-user.js";
import { CommandCreationReview, commandInspectionInputSchema, publishReviewedCommand,
  type CommandCreationReviewer, type CommandPublicationOptions } from "../core/programmatic/command-creation.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { stableJson } from "../core/tauri-package/paths.js";
import { CommandVerification, commandVerificationPlanSchema } from "../core/programmatic/command-verification.js";

export const ProgrammaticCommandParams = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("run"), selection: directCommandSelectionV1Schema }),
  z.strictObject({ action: z.literal("inspect"), proposal: commandInspectionInputSchema }),
  z.strictObject({ action: z.literal("create"), handle: z.string().uuid() }),
  z.strictObject({ action: z.literal("prepare_verification"), handle: z.string().uuid(), plan: commandVerificationPlanSchema }),
  z.strictObject({ action: z.literal("verification"), handle: z.string().uuid(), receipt_ids: z.array(z.string().uuid()).max(64).default([]),
    arguments: z.string().max(4000).default(""), model_judgment: z.string().min(1).max(4000).optional() }),
]);

export function createProgrammaticCommandTool(cwd: string, options: CommandPublicationOptions & {
  reviewCreation?: CommandCreationReviewer;
  executeCommand?: DirectCommandExecutor;
  planModeRef?: { current: boolean };
  getModel?: () => { provider: string; model: string };
}) {
  const verification = new CommandVerification(options, options.getModel);
  const review = new CommandCreationReview(cwd, options);
  const tool: AgentTool<typeof ProgrammaticCommandParams> = {
    name: "programmatic_command",
    description: "Inspect/create a missing project command or request a separately reviewed run of an existing canonical command. Run requires a supported desktop code-mode host, exact content/policy approval and separate mutation approvals. Creation/verification never approves execution or grants tools. Declare sorted project-relative helpers/prerequisites and required tools; no installs, global promotion, recursive runs or OS confinement. Completed tool calls do not prove behavioral correctness.",
    parameters: ProgrammaticCommandParams,
    executionMode: "sequential",
    // Match ask_user: the question owner expires review before the tool deadline.
    timeoutMs: ASK_USER_TIMEOUT_MS + 30_000,
    async execute(input, context) {
      if (options.localFilesystem === false) return stableJson({ status: "unavailable", reason: "local-filesystem-required" });
      if (input.action === "run") {
        if (isPlanModeActive(options.planModeRef)) return planModeRestriction("programmatic_command");
        if (!options.executeCommand) return stableJson({ status: "unavailable", reason: "Reviewed execution requires a supported desktop code-mode host. Creation and verification do not approve execution." });
        return stableJson(await options.executeCommand({ selection: input.selection, signal: context.signal, discovery: options, availableTools: options.availableTools }));
      }
      if (input.action === "inspect") {
        verification.clear();
        return stableJson(await review.inspect(input.proposal, context.signal));
      }
      // Preserve independent loading/snapshot observations even when receipt evidence is unavailable.
      // An omitted loads field is unknown, not false; neither observation approves execution.
      if (input.action === "verification") return stableJson(await verification.inspect(input.handle, input.receipt_ids, input.arguments, context.signal, input.model_judgment));
      if (input.action === "prepare_verification") return stableJson(await verification.prepare(input.handle, input.plan, context.signal));
      if (isPlanModeActive(options.planModeRef)) { review.cancel(); return planModeRestriction("programmatic_command"); }
      return stableJson(await review.consume(input.handle, context.signal, async (proposal, signal) => {
        const result = await publishReviewedCommand(proposal, options, signal);
        // Publication may have committed before cancellation. Preserve its result,
        // but never revive session evidence after the owner cancelled the review.
        const retain = result.created && !signal.aborted;
        if (retain) verification.created(proposal);
        return { ...result, ...(retain ? { verificationHandle: proposal.proposal.proposalId } : {}) };
      }));
    },
  };
  return { tool, verification, inspectionEvidence: (text: string) => review.inspectionEvidence(text), dispose: () => { review.dispose(); verification.clear(); },
    cancel: () => { review.cancel(); verification.clear(); } };
}
