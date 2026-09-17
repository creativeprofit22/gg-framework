import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProgrammaticAdvisoryTurn } from "../core/programmatic/advisory.js";
import { programmaticAssessmentResultV2Schema } from "../core/programmatic/contracts.js";
import {
  checkAdvisoryCommandSnapshot,
  type CommandInformationParams,
} from "./command-information.js";

/** Scoped transcript result tool; owns no persistence, scanner or execution state. */
export function createProgrammaticAdvisoryResultTool(
  getTurn: () => ProgrammaticAdvisoryTurn | undefined,
  commandInformation?: AgentTool<typeof CommandInformationParams>,
): AgentTool<typeof programmaticAssessmentResultV2Schema> {
  return {
    name: "programmatic_advisory_result",
    description:
      "Submit V2 needs-first advice, not execution: required workflow, repeatability basis, rationale, alternatives, uncertainty and evidence. Choose reuse unchanged, extension proposal, missing-capability proposal, manual, or needs-more-evidence. Positive automation needs local inspection and a meaningful alternative; explain prerequisite relevance for every concrete command comparison. Evidence source must be a host receipt ID (explicit assumptions use source=assumption); external citations must match provenance. Reuse/extension/compared available commands need delivered host snapshots; unresolved extensions need more evidence. At most 10 recommendations and 64,000 characters including limitations; empty is valid. Recommendations — not started writes no files, lifecycle or approvals. Extensions require a later authorized edit/review; app/native gaps remain development work.",
    parameters: programmaticAssessmentResultV2Schema,
    execute: async (input, context) => {
      const turn = getTurn();
      if (!turn) throw new Error("No active host advisory turn.");
      return turn.submit(input, {
        snapshot: (snapshot) => commandInformation
          ? checkAdvisoryCommandSnapshot(commandInformation, snapshot, context) : Promise.resolve(false),
        page: async (offset) => {
          if (!commandInformation) throw new Error("Command catalog unavailable under host policy.");
          return JSON.parse(String(await commandInformation.execute({ action: "list", offset }, context))) as unknown;
        },
        signal: context.signal,
      });
    },
  };
}
