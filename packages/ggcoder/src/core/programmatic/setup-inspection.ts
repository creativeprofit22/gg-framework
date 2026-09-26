import type { AgentTool } from "@kenkaiiii/gg-agent";
import { getMcpToolIdentity } from "../mcp/tool-identity.js";

export const SETUP_ASSESSMENT_TOOLS = new Set([
  "read", "find", "grep", "ls", "code_search", "code_nav",
  "command_information", "programmatic_advisory_result", "programmatic_profile",
]);

/** Host-resolved invocation capability, independent of the model's interpretation of the prompt. */
export class ProgrammaticSetupInspection {
  active = true;
  private inspected = false;
  /** Opt in only from the shared assessment owner; legacy session wiring stays unchanged. */
  constructor(private readonly assessment = false) {}
  allows(name: string): boolean {
    return this.active && (this.assessment ? SETUP_ASSESSMENT_TOOLS.has(name) : name === "programmatic_profile" || name === "tool_search");
  }
  claim(tool: AgentTool, args: unknown): void {
    if (!this.allows(tool.name) || getMcpToolIdentity(tool))
      throw new Error("Tool unavailable during inspect-only programmatic setup.");
    this.claimName(tool.name, args);
  }
  claimName(name: string, args: unknown): void {
    if (!this.allows(name)) throw new Error("Tool unavailable during inspect-only programmatic setup.");
    if (name === "programmatic_profile") {
      if (!args || typeof args !== "object" || Array.isArray(args) || !("action" in args) || args.action !== "inspect" || Object.keys(args).some((key) => key !== "action"))
        throw new Error("Initial setup is inspect-only; generation requires a later invocation and separate host review.");
      if (this.inspected) throw new Error("Setup was already inspected in this invocation.");
      this.inspected = true;
    }
  }
  close(): void { this.active = false; }
}

export function guardSetupInspectionTools(
  scope: ProgrammaticSetupInspection, getTools: () => AgentTool[],
): AgentTool[] {
  return getTools().filter((tool) => scope.allows(tool.name) && !getMcpToolIdentity(tool)).map((tool) => ({
    ...tool,
    execute: (args, context) => {
      if (!getTools().includes(tool)) throw new Error("Setup tool registration changed.");
      context.signal.throwIfAborted();
      scope.claim(tool, args);
      return tool.execute(args, context);
    },
  }));
}
