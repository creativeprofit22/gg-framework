import { getSafeToolEnv } from "../../tools/safe-env.js";

/** Build a stdio MCP child's environment without inheriting parent-process secrets. */
export function buildMcpStdioEnv(
  configuredEnv: Record<string, string> | undefined,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { ...getSafeToolEnv(sourceEnv), ...configuredEnv };
}
