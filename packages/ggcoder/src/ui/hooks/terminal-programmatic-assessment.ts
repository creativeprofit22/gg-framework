import type { AgentTool } from "@kenkaiiii/gg-agent";
import { createProgrammaticReadinessReader, discoverCommands, programmaticReadinessGuidance } from "../../core/command-discovery.js";
import { getMcpToolIdentity } from "../../core/mcp/tool-identity.js";
import { buildProgrammaticAdvisoryContext, buildProgrammaticAssessmentContext, parseProgrammaticAssessmentInput, renderProgrammaticAdvisoryContext } from "../../core/programmatic/advisory-context.js";
import { recheckAssessmentEvidence, type AssessmentEvidenceAuthorization } from "../../core/programmatic/assessment-evidence.js";
import { ProgrammaticAssessmentCoordinator } from "../../core/programmatic/assessment.js";
import { UI_SLASH_COMMANDS } from "../submit-slash-commands.js";

export interface TerminalProgrammaticAssessment {
  cwd: string;
  mode: "setup" | "configured";
  focus?: string;
}

/** Terminal adapter only: existing tools, shared evidence/coordinator, no new provider or scan engine. */
export async function prepareTerminalProgrammaticAssessment(
  input: TerminalProgrammaticAssessment, getTools: () => AgentTool[], signal: AbortSignal,
) {
  const parsed = parseProgrammaticAssessmentInput(input.focus ?? "");
  if (!parsed.success || (input.mode !== "setup" && input.mode !== "configured")) throw new Error("Invalid assessment input.");
  const readReadiness = createProgrammaticReadinessReader(input.cwd);
  if (input.mode === "configured") {
    const blocked = programmaticReadinessGuidance(await readReadiness());
    if (blocked) throw new Error(blocked);
  }
  signal.throwIfAborted();
  const discovery = await discoverCommands(input.cwd, { workspaceActions: UI_SLASH_COMMANDS, readReadiness });
  // Terminal capabilities are the live host registry. Do not treat MCP names or
  // a replacement/late registration as permission for direct bounded evidence I/O.
  const captured = getTools().filter((tool) => !getMcpToolIdentity(tool));
  const authorization: AssessmentEvidenceAuthorization = {
    isAllowed: ({ name }) => !signal.aborted && captured.some((tool) => tool.name === name && getTools().includes(tool)),
    authorize: async (request) => authorization.isAllowed(request),
  };
  const context = await buildProgrammaticAssessmentContext(parsed.data, discovery, input.cwd, { signal, authorization }).catch((error: unknown) => {
    if (!signal.aborted) throw error;
    return buildProgrammaticAdvisoryContext(parsed.data, discovery);
  });
  // Abort revokes cached capabilities immediately, but leave settlement to the
  // coordinator: cancellation cannot undo a scan that already persisted state.
  const coordinator = new ProgrammaticAssessmentCoordinator(input.cwd, context, () => signal.aborted ? [] : getTools(), { mode: input.mode });
  const facts: { setupFacts?: unknown; scanFacts?: unknown } = {};
  let basePrompt = "";
  const refreshPrompt = () => {
    if (context.evidence) recheckAssessmentEvidence(context.evidence, authorization);
    return basePrompt + `\n\nHost-owned exact facts (not model authority; already collected, do not repeat):\n${JSON.stringify(facts)}\nReusable host evidence receipts:\n${JSON.stringify(coordinator.scope.turn.evidence.list())}` + renderProgrammaticAdvisoryContext(context);
  };
  return {
    coordinator,
    refreshPrompt,
    async hostPrompt(prompt: string): Promise<string> {
      const { turn, tools } = coordinator.scope;
      const name = input.mode === "setup" ? "programmatic_profile" : "programmatic_scan";
      const tool = tools.find((candidate) => candidate.name === name);
      basePrompt = prompt;
      if (tool) {
        try {
          const output = await tool.execute(input.mode === "setup" ? { action: "inspect" } : {}, { signal, toolCallId: "assessment-host-facts" });
          const raw = typeof output === "string" ? output : output.content;
          if (typeof raw !== "string") throw new Error("Non-text host facts.");
          const value = JSON.parse(raw);
          if (input.mode === "setup") facts.setupFacts = value;
          else {
            facts.scanFacts = value;
            if (value?.ok === true) coordinator.recordScanCounts(value.scan_counts);
          }
        } catch {
          turn.limitations.add(`${name}: host facts unavailable; no retry attempted.`);
        }
      } else {
        turn.limitations.add(`${name}: host facts unavailable; no retry attempted.`);
        if (input.mode === "configured") turn.markScanUnavailable();
      }
      signal.throwIfAborted();
      return refreshPrompt();
    },
  };
}
