import os from "node:os";
import type { ThinkingLevel } from "../types.js";

// Advertised Codex client version. The ChatGPT backend gates models on it, and
// the live gate can be stricter than the bundled catalog's
// `minimal_client_version`: GPT-6.1 Sol is listed at 0.153.0 there, but the
// server only serves it from 0.159.0 (GET /codex/models?client_version=...,
// 2026-09-30). Below the gate it answers "The '<model>' model is not supported
// when using Codex with a ChatGPT account". Track the latest openai/codex
// `rust-v*` release when adding a model, and check that model's live listing.
const CODEX_CLIENT_VERSION = "0.159.1";

// GPT-6 point releases (gpt-6.1-sol) keep the dotted version in the id, so a
// bare `gpt-6-` prefix would miss them.
function usesResponsesLite(model: string): boolean {
  return model.startsWith("gpt-5.6-") || model.startsWith("gpt-6-") || model.startsWith("gpt-6.");
}

/** Shared wire profile; image-result handling remains separate from text streaming. */
export function codexRequestProfile(model: string, thinking?: ThinkingLevel) {
  const responsesLite = usesResponsesLite(model);
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
    // Catalog parity: every responses-lite model (gpt-6-astra, gpt-6.1-sol,
    // gpt-6-luna and the older gpt-6-sol and gpt-5.6-sol/terra/luna) declares
    // `support_verbosity: true` with `default_verbosity: "low"` in openai/codex
    // models.json, and the Codex CLI sends `text.verbosity` accordingly. Omitting
    // it leaves the server default in place, which produces noticeably longer
    // outputs — slower turns and heavier usage burn on exactly these
    // deep-reasoning models.
    text: responsesLite ? { verbosity: "low" } : undefined,
    reasoning: {
      // GPT-5.6/6 require at least low; older models still support thinking off.
      // `ultra` is a client orchestration preset, not a Codex API effort.
      effort: thinking === "ultra" ? "max" : (thinking ?? (responsesLite ? "low" : "none")),
      summary: "auto",
      ...(responsesLite ? { context: "all_turns" } : {}),
    },
  };
}
