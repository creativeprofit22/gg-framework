import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProgrammaticAdvisoryTurn } from "../core/programmatic/advisory.js";
import { programmaticAssessmentResultV1Schema } from "../core/programmatic/contracts.js";
import {
  checkAdvisoryCommandSnapshot,
  type CommandInformationParams,
} from "./command-information.js";

/** Scoped transcript result tool; owns no persistence, scanner or execution state. */
export function createProgrammaticAdvisoryResultTool(
  getTurn: () => ProgrammaticAdvisoryTurn | undefined,
  commandInformation: AgentTool<typeof CommandInformationParams>,
): AgentTool<typeof programmaticAssessmentResultV1Schema> {
  return {
    name: "programmatic_advisory_result",
    description:
      "Submit bounded advisory choices, not execution. Evidence item source must be a host receipt ID (explicit assumptions use source=assumption). External citations must match receipt provenance exactly. Available commands require a resolved host snapshot and inspected local prerequisite evidence. Result appears separately as Recommendations — not started. No files, lifecycle or approvals are written.",
    parameters: programmaticAssessmentResultV1Schema,
    execute: async (input, context) => {
      const turn = getTurn();
      if (!turn) throw new Error("No active host advisory turn.");
      return turn.submit(input, {
        snapshot: (snapshot) => checkAdvisoryCommandSnapshot(commandInformation, snapshot, context),
        page: async (offset) =>
          JSON.parse(
            String(await commandInformation.execute({ action: "list", offset }, context)),
          ) as unknown,
        signal: context.signal,
      });
    },
  };
}
