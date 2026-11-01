import type { ToolExecuteResult } from "@kenkaiiii/gg-agent";

/** The model-visible text of a tool result, string or structured. */
export function toolText(result: ToolExecuteResult | undefined): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}
