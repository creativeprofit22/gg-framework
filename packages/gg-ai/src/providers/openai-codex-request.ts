import os from "node:os";
import type { ThinkingLevel } from "../types.js";

const CODEX_CLIENT_VERSION = "0.153.4";

/** Shared wire profile; image-result handling remains separate from text streaming. */
export function codexRequestProfile(model: string, thinking?: ThinkingLevel) {
  const responsesLite = model.startsWith("gpt-5.6-") || model.startsWith("gpt-6-");
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    originator: responsesLite ? "codex_cli_rs" : "ggcoder",
    "User-Agent": responsesLite
      ? `codex_cli_rs/${CODEX_CLIENT_VERSION}`
      : `ggcoder (${os.platform()} ${os.release()}; ${os.arch()})`,
    ...(responsesLite
      ? { version: CODEX_CLIENT_VERSION, "X-OpenAI-Internal-Codex-Responses-Lite": "true" }
      : {}),
  };
  return {
    headers,
    parallelToolCalls: !responsesLite,
    reasoning: {
      effort: thinking === "ultra" ? "max" : (thinking ?? (responsesLite ? "low" : "none")),
      summary: "auto",
      ...(responsesLite ? { context: "all_turns" } : {}),
    },
  };
}
