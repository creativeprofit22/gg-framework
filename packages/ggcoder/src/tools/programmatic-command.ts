import { randomUUID } from "node:crypto";
import { z } from "zod";
import { directCommandSelectionV1Schema } from "../core/programmatic/contracts.js";
import {
  claimProgrammaticProject,
  EXECUTION_DEADLINE_MS,
  type DirectCommandExecutor,
} from "../core/programmatic/execution.js";
import { applyFamily, planFamily, type FamilyPlan } from "../core/programmatic/family-apply.js";
import { isSafeRepositoryPath } from "../core/programmatic/family-generator.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ASK_USER_TIMEOUT_MS } from "../core/ask-user.js";
import {
  CommandCreationReview,
  commandInspectionInputSchema,
  publishReviewedCommand,
  type CommandCreationReviewer,
  type CommandPublicationOptions,
} from "../core/programmatic/command-creation.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { sha256, stableJson } from "../core/tauri-package/paths.js";
import {
  CommandVerification,
  commandVerificationPlanSchema,
} from "../core/programmatic/command-verification.js";

export const ProgrammaticCommandParams = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("run"), selection: directCommandSelectionV1Schema }),
  z.strictObject({ action: z.literal("inspect"), proposal: commandInspectionInputSchema }),
  z.strictObject({ action: z.literal("create"), handle: z.string().uuid() }),
  z.strictObject({
    action: z.literal("prepare_verification"),
    handle: z.string().uuid(),
    plan: commandVerificationPlanSchema,
  }),
  z.strictObject({
    action: z.literal("verification"),
    handle: z.string().uuid(),
    receipt_ids: z.array(z.string().uuid()).max(64).default([]),
    arguments: z.string().max(4000).default(""),
    model_judgment: z.string().min(1).max(4000).optional(),
  }),
  z.strictObject({
    action: z.literal("preview_family"),
    handle: z.string().uuid(),
    /** Defaults to every member except the reference. */
    members: z
      .array(z.string().refine(isSafeRepositoryPath, "unsafe member path"))
      .min(1)
      .max(12)
      .optional(),
  }),
  z.strictObject({
    action: z.literal("apply_family"),
    handle: z.string().uuid(),
    preview_id: z.string().uuid(),
  }),
]);

const pendingPreviewSchema = z.strictObject({
  members: z.array(z.string()).optional(),
  previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

function previewSummary(plan: FamilyPlan) {
  return {
    members: plan.members.map((member) => ({
      path: member.path,
      status: member.status,
      ...(member.reason ? { reason: member.reason } : {}),
      files: member.files.map((file) => ({
        path: file.path,
        action: file.action,
        ...(file.reason ? { reason: file.reason } : {}),
      })),
    })),
    git: plan.git,
    projectCheck: plan.projectCheck,
  };
}

export function createProgrammaticCommandTool(
  cwd: string,
  options: CommandPublicationOptions & {
    reviewCreation?: CommandCreationReviewer;
    executeCommand?: DirectCommandExecutor;
    planModeRef?: { current: boolean };
    getModel?: () => { provider: string; model: string };
  },
) {
  const verification = new CommandVerification(options, options.getModel);
  const review = new CommandCreationReview(cwd, options);
  // Aborted by cancel/dispose so an open apply question or member loop stops.
  let applyOwner = new AbortController();
  const stopApply = () => {
    applyOwner.abort();
    applyOwner = new AbortController();
  };

  /** No-write preview of a verified generator across the family; allowed in plan mode. */
  async function previewFamily(
    handle: string,
    members: readonly string[] | undefined,
    signal: AbortSignal,
  ) {
    const generator = await verification.generatorForApply(handle, signal);
    if (generator.status !== "ready") return generator;
    const result = await planFamily(generator, members ? { members } : {}, signal);
    if (result.status !== "planned") return result;
    if (!verification.isCurrent(generator.generation) || signal.aborted)
      return { status: "unavailable", reason: "stale-generator-verify-again" };
    const previewId = randomUUID();
    verification.setPendingPreview(handle, previewId, {
      ...(members ? { members: [...members] } : {}),
      previewSha256: result.plan.previewSha256,
    });
    return {
      status: "previewed",
      written: false,
      previewId,
      previewSha256: result.plan.previewSha256,
      preview: result.plan.text,
      ...previewSummary(result.plan),
      nextStep:
        "apply_family with this preview_id asks the user for a separate approval. The preview is single-use and any change to the generator, members, files or git state makes it stale.",
    };
  }

  /** Separate approval bound to the exact preview, then member-by-member apply. */
  async function applyPreviewedFamily(handle: string, previewId: string, toolSignal: AbortSignal) {
    // Consume before any await: a preview approves at most one apply.
    const pending = pendingPreviewSchema.safeParse(
      verification.consumePendingPreview(handle, previewId),
    );
    const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
    if (!pending.success) return unavailable("unknown-or-consumed-preview");
    if (!options.reviewCreation) return unavailable("apply-review-unavailable");
    const signal = AbortSignal.any([toolSignal, applyOwner.signal]);
    const expected = pending.data;
    const fresh = async () => {
      const generator = await verification.generatorForApply(handle, signal);
      if (generator.status !== "ready") return generator;
      const result = await planFamily(
        generator,
        expected.members ? { members: expected.members } : {},
        signal,
      );
      if (result.status !== "planned") return result;
      if (
        result.plan.previewSha256 !== expected.previewSha256 ||
        !verification.isCurrent(generator.generation)
      )
        return unavailable("stale-preview-review-again");
      return { status: "fresh" as const, generator, plan: result.plan };
    };
    try {
      const before = await fresh();
      if (before.status !== "fresh") return before;
      const plan = before.plan;
      if (!plan.members.some((member) => member.status === "ready"))
        return { ...unavailable("nothing-to-apply"), preview: plan.text };
      const dirty = plan.git.repository ? plan.git.dirty : [];
      // Values bind the exact preview digest and dirty list; the nonce stops replayed answers.
      const bound = `${plan.previewSha256}:${randomUUID()}${dirty.length ? `:dirty-${sha256(stableJson(dirty))}` : ""}`;
      const withCheck = `apply-check:${bound}`;
      const withoutCheck = `apply:${bound}`;
      const despite = dirty.length ? " despite uncommitted changes" : "";
      const questionId = randomUUID();
      const answer = await options.reviewCreation(
        {
          questions: [
            {
              id: questionId,
              kind: "choice",
              allowOther: false,
              question: `Write the previewed generator output to ${plan.members.length} family member(s)${despite}? Each member is written and rolled back on its own; unowned files are never overwritten.`,
              detail: plan.text,
              options: [
                ...(plan.projectCheck
                  ? [
                      {
                        label: `Apply${despite} and run \`${plan.projectCheck}\` after each member`,
                        value: withCheck,
                      },
                      {
                        label: `Apply${despite} without the project check`,
                        hint: "Only exact rendering is checked.",
                        value: withoutCheck,
                      },
                    ]
                  : [{ label: `Apply${despite}`, value: withoutCheck }]),
                { label: "Do not apply", value: "reject", recommended: true },
              ],
            },
          ],
        },
        signal,
      );
      signal.throwIfAborted();
      const choice = answer.action === "answer" ? answer.answers[questionId] : undefined;
      if (choice !== withCheck && choice !== withoutCheck) return unavailable("apply-not-approved");
      if (isPlanModeActive(options.planModeRef)) return unavailable("plan-mode");
      const after = await fresh();
      if (after.status !== "fresh") return after;
      const release = claimProgrammaticProject(after.generator.root);
      if (!release) return unavailable("project-busy");
      try {
        const report = await applyFamily({
          root: after.generator.root,
          plan: after.plan,
          runProjectCheck: choice === withCheck,
          dirtyOverride: dirty.length > 0,
          signal,
          deadlineMs: EXECUTION_DEADLINE_MS,
          ...(options.onPreFileMutation ? { onPreMutation: options.onPreFileMutation } : {}),
          ...(options.onFileMutated ? { onMutated: options.onFileMutated } : {}),
        });
        return { status: "applied", report };
      } finally {
        release();
      }
    } catch {
      return unavailable(signal.aborted ? "cancelled" : "apply-failed");
    }
  }
  const tool: AgentTool<typeof ProgrammaticCommandParams> = {
    name: "programmatic_command",
    description:
      "Inspect/create a missing project command or request a separately reviewed run of an existing canonical command. Run requires a supported desktop code-mode host, exact content/policy approval and separate mutation approvals. Creation/verification never approves execution or grants tools. Declare sorted project-relative helpers/prerequisites and required tools. For a script-backed generator, pass `generator` (template, reference and one input record per family member) instead of helpers; the host writes its own Node helper, and verification accepts the template only if it rebuilds the reference byte for byte. After that passes, `preview_family` lists what each other member would create, change, skip or conflict on without writing; `apply_family` with its preview_id asks a separate approval, refuses dirty affected paths unless overridden, never overwrites unowned files, and writes each member with its own rollback and report. No installs, global promotion, recursive runs or OS confinement. Completed tool calls do not prove behavioral correctness.",
    parameters: ProgrammaticCommandParams,
    executionMode: "sequential",
    // Outer bound only: apply_family waits up to ASK_USER_TIMEOUT_MS for its
    // approval and then gives applyFamily its own fresh EXECUTION_DEADLINE_MS,
    // so the ceiling must cover both plus planning slack. Every other action
    // keeps its inner bound: the question owner expires reviews, run arms
    // EXECUTION_DEADLINE_MS itself and generator renders use their own limit.
    timeoutMs: ASK_USER_TIMEOUT_MS + EXECUTION_DEADLINE_MS + 60_000,
    async execute(input, context) {
      if (options.localFilesystem === false)
        return stableJson({ status: "unavailable", reason: "local-filesystem-required" });
      if (input.action === "run") {
        if (isPlanModeActive(options.planModeRef))
          return planModeRestriction("programmatic_command");
        if (!options.executeCommand)
          return stableJson({
            status: "unavailable",
            reason:
              "Reviewed execution requires a supported desktop code-mode host. Creation and verification do not approve execution.",
          });
        return stableJson(
          await options.executeCommand({
            selection: input.selection,
            signal: context.signal,
            discovery: options,
            availableTools: options.availableTools,
          }),
        );
      }
      if (input.action === "inspect") {
        verification.clear();
        return stableJson(await review.inspect(input.proposal, context.signal));
      }
      // Preserve independent loading/snapshot observations even when receipt evidence is unavailable.
      // An omitted loads field is unknown, not false; neither observation approves execution.
      if (input.action === "verification")
        return stableJson(
          await verification.inspect(
            input.handle,
            input.receipt_ids,
            input.arguments,
            context.signal,
            input.model_judgment,
          ),
        );
      if (input.action === "prepare_verification")
        return stableJson(await verification.prepare(input.handle, input.plan, context.signal));
      if (input.action === "preview_family")
        return stableJson(await previewFamily(input.handle, input.members, context.signal));
      if (input.action === "apply_family") {
        if (isPlanModeActive(options.planModeRef)) {
          verification.consumePendingPreview(input.handle, input.preview_id);
          return planModeRestriction("programmatic_command");
        }
        return stableJson(
          await applyPreviewedFamily(input.handle, input.preview_id, context.signal),
        );
      }
      if (isPlanModeActive(options.planModeRef)) {
        review.cancel();
        return planModeRestriction("programmatic_command");
      }
      return stableJson(
        await review.consume(input.handle, context.signal, async (proposal, signal) => {
          const result = await publishReviewedCommand(proposal, options, signal);
          // Publication may have committed before cancellation. Preserve its result,
          // but never revive session evidence after the owner cancelled the review.
          const retain = result.created && !signal.aborted;
          if (retain) verification.created(proposal);
          return {
            ...result,
            ...(retain ? { verificationHandle: proposal.proposal.proposalId } : {}),
          };
        }),
      );
    },
  };
  return {
    tool,
    verification,
    inspectionEvidence: (text: string) => review.inspectionEvidence(text),
    dispose: () => {
      review.dispose();
      verification.clear();
      stopApply();
    },
    cancel: () => {
      review.cancel();
      verification.clear();
      stopApply();
    },
  };
}
