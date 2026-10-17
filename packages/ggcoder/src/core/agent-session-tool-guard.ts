// Local Fork-owned: guarded tool execution for AgentSession. Kept out of
// agent-session.ts so upstream syncs of that file stay small.
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { CreateToolsResult } from "../tools/index.js";
import type { AgentSessionOptions } from "./agent-session.js";
import {
  getMcpToolIdentity,
  sameMcpToolIdentity,
  withMcpToolIdentity,
} from "./mcp/tool-identity.js";
import type { ProgrammaticAdvisoryTurn } from "./programmatic/advisory.js";
import { claimAdvisoryTool, executeAdvisoryTool } from "./programmatic/advisory-tools.js";
import type { DiscoveryReviewBoundary } from "./programmatic/discovery-review.js";
import type { ProgrammaticSetupInspection } from "./programmatic/setup-inspection.js";

/** Live AgentSession state read by the guard; every member reads the current value. */
export interface SessionToolGuardHost {
  registeredTool(name: string): AgentTool | undefined;
  isUnavailable(name: string): boolean;
  isCapabilityAllowed(name: string): boolean;
  unavailableMessage(name: string): string | undefined;
  discoveryReview(): DiscoveryReviewBoundary | undefined;
  setupInspection(): ProgrammaticSetupInspection | undefined;
  advisoryTurn(): ProgrammaticAdvisoryTurn | undefined;
  commandCreation(): CreateToolsResult["commandCreation"] | undefined;
  cwd(): string;
  options(): Pick<AgentSessionOptions, "approveToolExecution" | "validateToolExecution">;
  setPendingAdvisoryPresentation(presentation: {
    turn: ProgrammaticAdvisoryTurn;
    text: string;
    signal: AbortSignal;
  }): void;
}

export function guardSessionTool(tool: AgentTool, host: SessionToolGuardHost): AgentTool {
  const identity = getMcpToolIdentity(tool);
  const guardedTool: AgentTool = {
    ...tool,
    onResultPrepared: (result) => {
      host.advisoryTurn()?.resultPrepared(result);
      host.commandCreation()?.verification.resultPrepared(result, tool.name);
      tool.onResultPrepared?.(result);
    },
    execute: async (args, context) => {
      const current = host.registeredTool(tool.name);
      let executionTarget = tool;
      if (current !== guardedTool) {
        if (!identity || !current || !sameMcpToolIdentity(current, identity)) {
          throw new Error(`${tool.name} is no longer registered.`);
        }
        // A provider turn may retain the cached wrapper while live discovery
        // replaces it. Same exact source identity may follow the replacement;
        // removal or a different identity still fails closed.
        executionTarget = current;
      }
      if (host.isUnavailable(tool.name)) {
        throw new Error(`${tool.name} is unavailable under the active host policy.`);
      }
      if (!host.isCapabilityAllowed(tool.name)) {
        throw new Error(
          host.unavailableMessage(tool.name) ??
            `${tool.name} is unavailable under the active tool capability policy.`,
        );
      }
      const review = host.discoveryReview();
      review?.claim(tool.name, args, identity !== undefined);
      const setupInspection = host.setupInspection();
      setupInspection?.claim(tool, args);
      const advisory = host.advisoryTurn();
      if (advisory) {
        claimAdvisoryTool(advisory, tool, args, identity !== undefined);
      }
      let commandReceipt: string | undefined;
      let output: Awaited<ReturnType<AgentTool["execute"]>> | undefined;
      try {
        output = await executeAdvisoryTool(
          advisory,
          host.cwd(),
          executionTarget,
          args,
          context,
          async () => {
            try {
              const options = host.options();
              if (
                options.approveToolExecution &&
                !(await options.approveToolExecution(tool.name, args, context.signal))
              ) {
                throw new Error("Tool execution was not approved.");
              }
              context.signal.throwIfAborted();
              if (
                host.setupInspection() !== setupInspection ||
                (setupInspection && !setupInspection.active) ||
                host.advisoryTurn() !== advisory ||
                (advisory && !advisory.active) ||
                host.registeredTool(tool.name) !== current ||
                !host.isCapabilityAllowed(tool.name) ||
                host.isUnavailable(tool.name)
              )
                throw new Error("Tool permissions changed before execution.");
              if (host.discoveryReview() !== review || (review && !review.active))
                throw new Error("Candidate review owner changed.");
              commandReceipt = await host
                .commandCreation()
                ?.verification.observeStart(tool.name, args, context);
              await host.options().validateToolExecution?.();
              context.signal.throwIfAborted();
              if (
                host.discoveryReview() !== review ||
                (review && !review.active) ||
                host.setupInspection() !== setupInspection ||
                (setupInspection && !setupInspection.active) ||
                host.advisoryTurn() !== advisory ||
                host.registeredTool(tool.name) !== current ||
                !host.isCapabilityAllowed(tool.name) ||
                host.isUnavailable(tool.name)
              )
                throw new Error("Tool permissions changed while observing verification inputs.");
            } catch (error) {
              if (advisory && tool.name === "programmatic_scan")
                advisory.settleScan(context.signal.aborted ? "cancelled" : "denied");
              throw error;
            }
          },
        );
        if (review && host.discoveryReview() === review && review.active && !context.signal.aborted)
          review.observe(host.cwd(), tool.name, args, output, context.toolCallId);
        // Do not accept result evidence against content that changed while the tool ran.
        await host.options().validateToolExecution?.();
      } finally {
        await host
          .commandCreation()
          ?.verification.observeEnd(commandReceipt, output, context.signal);
      }
      if (
        advisory &&
        tool.name === "programmatic_advisory_result" &&
        advisory.submitted &&
        host.advisoryTurn() === advisory &&
        advisory.active &&
        !context.signal.aborted &&
        typeof output === "string"
      ) {
        host.setPendingAdvisoryPresentation({
          turn: advisory,
          text: output,
          signal: context.signal,
        });
      }
      return output;
    },
  };
  return identity ? withMcpToolIdentity(guardedTool, identity) : guardedTool;
}
