/**
 * Live cache-hit e2e — the KV-cache regression tripwire.
 *
 * Proves end-to-end, against the real Anthropic API, that a multi-step tool
 * turn preserves its prompt prefix: every provider request after the first
 * must report cacheRead > 0. A reorder in the tool array, a volatile section
 * leaking into the system prompt, or an unstable serialization anywhere in
 * gg-ai/gg-agent collapses cacheRead to 0 here — and passes every mock-based
 * test on the way to the user's bill (deepseek-harness takeaway: a with-key
 * run is the only proof the agent works against a real provider).
 *
 * Gates: skips unless GG_LIVE_E2E is set, so plain `pnpm test` never spends
 * tokens. Credentials come from ANTHROPIC_API_KEY or the logged-in AuthStorage
 * (the same path a real session uses); opting into GG_LIVE_E2E without either
 * is a hard failure, not a silent skip.
 * Intentional runs: GG_LIVE_E2E=1 pnpm vitest run src/core/provider-cache.e2e.test.ts
 * (~4 live requests).
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { z } from "zod";
import type { AgentEvent, AgentTool } from "@kenkaiiii/gg-agent";
import { agentLoop } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import { buildSystemPrompt } from "../system-prompt.js";
import { DEFAULT_TOOL_NAMES } from "../tools/prompt-hints.js";
import { AuthStorage } from "./auth-storage.js";

const MODEL = "claude-sonnet-5";

/**
 * Rigid task wording (dsh's pattern): literal single-sentence instructions
 * keep the model deterministic about calling the tool and stopping, so the
 * test measures cache behavior, not the model's mood.
 */
const TASK_PROMPT =
  'Call the lookup tool with key "falcon" exactly once, wait for its result, ' +
  "then reply with a single short sentence that repeats the returned value " +
  "verbatim. No markdown, no explanations, no follow-up questions.";

const FOLLOW_UP_PROMPT =
  'Now call the lookup tool with key "heron" exactly once and reply with a ' +
  "single short sentence repeating that returned value verbatim.";

const lookupTool: AgentTool = {
  name: "lookup",
  description: "Look up the stored value for a key.",
  parameters: z.object({ key: z.string().describe("The key to look up.") }),
  execute: async (args) => `value(${String((args as { key: string }).key)}) = azure-falcon-42`,
};

interface TurnUsage {
  turn: number;
  cacheRead?: number;
  inputTokens: number;
}

/**
 * Resolved once: env var first (CI), else AuthStorage — the same credential
 * path a real session uses (OAuth accessToken becomes the bearer key, with
 * accountId/baseUrl forwarded).
 */
async function resolveCreds(): Promise<{
  apiKey: string;
  accountId?: string;
  baseUrl?: string;
} | null> {
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };
  try {
    const authStorage = new AuthStorage();
    await authStorage.load();
    const creds = await authStorage.resolveCredentials("anthropic");
    return {
      apiKey: creds.accessToken,
      ...(creds.accountId ? { accountId: creds.accountId } : {}),
      ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * One loop run. `messages` is mutated in place by the loop (assistant and
 * tool messages are appended to the caller's array — the same contract the
 * session relies on), so consecutive runs extend the same history.
 */
async function runTurn(
  messages: Message[],
  opts: {
    promptCacheKey: string;
    creds: { apiKey: string; accountId?: string; baseUrl?: string };
  },
): Promise<TurnUsage[]> {
  const usage: TurnUsage[] = [];
  for await (const ev of agentLoop(messages, {
    provider: "anthropic",
    model: MODEL,
    apiKey: opts.creds.apiKey,
    ...(opts.creds.accountId ? { accountId: opts.creds.accountId } : {}),
    ...(opts.creds.baseUrl ? { baseUrl: opts.creds.baseUrl } : {}),
    tools: [lookupTool],
    maxTurns: 6,
    maxTokens: 512,
    promptCacheKey: opts.promptCacheKey,
  })) {
    if ((ev as AgentEvent).type === "turn_end") {
      const { turn, usage: u } = ev as Extract<AgentEvent, { type: "turn_end" }>;
      usage.push({ turn, cacheRead: u.cacheRead, inputTokens: u.inputTokens });
    }
  }
  return usage;
}

describe("provider prompt-cache hit (live Anthropic)", () => {
  const live = !!process.env.GG_LIVE_E2E;

  it.skipIf(!live)(
    "reports cacheRead > 0 on every request after the first",
    async () => {
      const creds = await resolveCreds();
      expect(
        creds,
        "no Anthropic credential (env ANTHROPIC_API_KEY or ggcoder login)",
      ).toBeTruthy();
      const cwd = path.resolve(import.meta.dirname, "../../.."); // repo root: real project context

      // Real system prompt with the real default tool names and the real
      // project context (CLAUDE.md et al). The prefix MUST exceed Anthropic's
      // 1024-token minimum cacheable prefix — a smaller prompt is silently
      // never cached, and the assertion below would misread that as a miss.
      const system = await buildSystemPrompt(cwd, [], false, undefined, DEFAULT_TOOL_NAMES);
      expect(system.length).toBeGreaterThan(6_000); // comfortably over the cache floor

      // The system prompt rides as messages[0] — the loop ignores
      // AgentOptions.system and the session's own convention is messages[0].
      const messages: Message[] = [
        { role: "system", content: system },
        { role: "user", content: TASK_PROMPT },
      ];
      const promptCacheKey = "gg-live-cache-e2e";

      // Turn 1: user → tool call → tool result → final answer (2+ requests).
      const turn1 = await runTurn(messages, { promptCacheKey, creds: creds! });
      // Turn 2 (fresh loop call, same system + key — the session-resume path):
      // the whole prior conversation is now the cached prefix.
      messages.push({ role: "user", content: FOLLOW_UP_PROMPT });
      const turn2 = await runTurn(messages, { promptCacheKey, creds: creds! });

      const perTurnUsage = [...turn1, ...turn2];
      if (process.env.GG_CACHE_E2E_DEBUG) console.log("[cache-e2e]", JSON.stringify(perTurnUsage));
      expect(perTurnUsage.length).toBeGreaterThanOrEqual(3);

      // ── The assertion that matters ──
      const misses = perTurnUsage.slice(1).filter((u) => !u.cacheRead || u.cacheRead <= 0);
      expect(
        misses,
        `cache misses on turns ${misses.map((m) => m.turn).join(", ")} — a prefix-cache ` +
          `regression (tool reorder, volatile system-prompt section, or unstable serialization)`,
      ).toEqual([]);
    },
    240_000,
  );
});
