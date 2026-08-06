// Bench E — prompt-cache cost of a mid-session model switch (Anthropic).
//
// A model switch changes model-dependent prompt content (the Sol/Terra async
// orchestration block). WHERE that content lives decides what the switch costs:
//
//   prefix-mutation — the old composition: model-dependent text appended to the
//                     system prompt with no `<!-- uncached -->` marker, so it
//                     sits inside the block that carries cache_control. Changing
//                     it invalidates the cached prefix.
//   tail-only       — the current composition: model-dependent text lives after
//                     the marker, so the cache_control block is byte-identical
//                     across the switch.
//
// Metric: cache-read tokens on the turn AFTER the switch. Run from repo root:
//   node bench/e-model-switch-cache.mjs
import { AuthStorage } from "../packages/gg-core/dist/index.js";
import { stream } from "../packages/gg-ai/dist/index.js";
import { fmt, pct, table, freshCacheKey } from "./lib.mjs";

const MODEL = "claude-sonnet-5";
const TURNS_BEFORE_SWITCH = 2;

const { buildSystemPrompt } = await import("../packages/ggcoder/dist/system-prompt.js");
const { applyAsyncSubagentPolicy } = await import("../packages/ggcoder/dist/core/subagent-policy.js");

const base = await buildSystemPrompt(process.cwd());

// The real orchestration block, for the two models either side of the switch.
const ultraBlock = applyAsyncSubagentPolicy("", "openai", "gpt-5.6-sol", "ultra", ["spawn_agent"]);
const plainBlock = applyAsyncSubagentPolicy("", "openai", "gpt-5.6-terra", "high", ["spawn_agent"]);

const compose = {
  "prefix-mutation": (block) => `${base}${block}`,
  "tail-only": (block) => `${base}\n\n<!-- uncached -->\n${block.trim()}`,
};

const QUESTIONS = [
  "One short sentence: what is a prompt cache?",
  "One short sentence: what invalidates it?",
  "One short sentence: why is a stable prefix worth money?",
];

const auth = new AuthStorage();
await auth.load();
const creds = await auth.resolveCredentials("anthropic");

async function turn(system, history, question, promptCacheKey) {
  history.push({ role: "user", content: question });
  const s = stream({
    provider: "anthropic",
    model: MODEL,
    apiKey: creds.accessToken,
    accountId: creds.accountId,
    baseUrl: creds.baseUrl,
    messages: [{ role: "system", content: system }, ...history],
    maxTokens: 60,
    promptCacheKey,
  });
  let text = "";
  for await (const ev of s) if (ev.type === "text_delta") text += ev.text;
  const resp = await s;
  history.push({ role: "assistant", content: text || "ok" });
  return resp.usage ?? {};
}

async function runArm(name) {
  const system = compose[name];
  const history = [];
  const cacheKey = freshCacheKey();
  const rows = [];
  for (let t = 0; t < QUESTIONS.length; t++) {
    // The switch happens between turn 2 and turn 3: same prompt, new model.
    const block = t < TURNS_BEFORE_SWITCH ? ultraBlock : plainBlock;
    const usage = await turn(system(block), history, QUESTIONS[t], cacheKey);
    rows.push({
      turn: t + 1,
      phase: t < TURNS_BEFORE_SWITCH ? "pre-switch" : "POST-SWITCH",
      input: usage.inputTokens ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    });
  }
  console.log(`\n[${name}]`);
  table(
    rows.map((r) => [String(r.turn), r.phase, fmt(r.input), fmt(r.cacheRead), fmt(r.cacheWrite)]),
    ["turn", "phase", "input", "cacheRead", "cacheWrite"],
  );
  return rows;
}

const results = {};
for (const arm of Object.keys(compose)) results[arm] = await runArm(arm);

const post = (rows) => rows.find((r) => r.phase === "POST-SWITCH");
const a = post(results["prefix-mutation"]);
const b = post(results["tail-only"]);
console.log("\n── Turn after the model switch ──");
table(
  [
    ["prefix-mutation", fmt(a.cacheRead), fmt(a.cacheWrite), fmt(a.input)],
    ["tail-only", fmt(b.cacheRead), fmt(b.cacheWrite), fmt(b.input)],
  ],
  ["arm", "cacheRead", "cacheWrite", "fresh input"],
);
const delta = b.cacheRead - a.cacheRead;
console.log(
  `\ncache-read delta (tail-only vs prefix-mutation): ${delta >= 0 ? "+" : ""}${fmt(delta)} tokens` +
    (a.cacheRead > 0 ? ` (+${fmt(pct(delta, a.cacheRead), 1)}%)` : ""),
);
