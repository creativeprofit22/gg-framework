import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSubAgentSystemPrompt,
  buildSystemPrompt,
  collectProjectContext,
  PROJECT_CONTEXT_MAX_BYTES,
} from "./system-prompt.js";
import { buildKenSystemPrompt } from "./core/ken-prompt.js";
import { resolveContextLimits } from "./core/context-limits.js";
import type { LanguageId } from "./core/language-detector.js";

const tempDirs: string[] = [];

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-system-prompt-"));
  tempDirs.push(cwd);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }
  return cwd;
}

function sectionIndex(prompt: string, heading: string): number {
  const index = prompt.indexOf(heading);
  expect(index, `${heading} should exist`).toBeGreaterThanOrEqual(0);
  return index;
}

function toolsSection(prompt: string): string {
  const start = sectionIndex(prompt, "## Tools");
  const rest = prompt.slice(start);
  const next = rest.indexOf("\n\n## ", "## Tools".length);
  return next === -1 ? rest : rest.slice(0, next);
}

function promptSize(prompt: string): { characters: number; lines: number; sections: number } {
  return {
    characters: prompt.length,
    lines: prompt.split("\n").length,
    sections: prompt.match(/^## /gm)?.length ?? 0,
  };
}

function promptAudit(prompt: string): { size: ReturnType<typeof promptSize>; flags: string[] } {
  const flags: string[] = [];
  const obsoleteOrContradictory = [
    "what observable artifact would prove the requested outcome worked end-to-end",
    "the simplest reliable local/free proof path",
    "generic tests, scripts, screenshots, benchmarks, or simulations; use them by default",
    "After meaningful edits, run the relevant verification commands below",
    "Run relevant checks after edits",
    "Run only targeted verification needed for the change",
    "Run targeted verification that is appropriate to the change before calling work complete",
    "plan multi-file work first",
    "otherwise follow through and verify",
  ];

  for (const phrase of obsoleteOrContradictory) {
    if (prompt.includes(phrase)) flags.push(`obsolete/contradictory guidance: ${phrase}`);
  }

  const repeatedSentences = new Map<string, number>();
  for (const sentence of prompt
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 80)) {
    repeatedSentences.set(sentence, (repeatedSentences.get(sentence) ?? 0) + 1);
  }
  for (const [sentence, count] of repeatedSentences) {
    if (count > 1) flags.push(`duplicate sentence x${count}: ${sentence}`);
  }

  return { size: promptSize(prompt), flags };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildSystemPrompt", () => {
  it("renders deterministic section order and keeps only the volatile date after the marker", async () => {
    const cwd = await makeProject({
      "CLAUDE.md": "Project rules win.",
      "package.json": JSON.stringify({ scripts: { check: "tsc --noEmit" } }),
      "tsconfig.json": "{}",
    });

    const prompt = await buildSystemPrompt(
      cwd,
      [{ name: "find-skills", description: "Find skills.", content: "", source: "test" }],
      false,
      undefined,
      ["read", "edit", "web_search", "skill"],
      new Set<LanguageId>(["typescript"]),
    );

    expect(prompt.startsWith("You are GG Coder by Ken Kai")).toBe(true);
    expect(sectionIndex(prompt, "## How to Talk")).toBeLessThan(
      sectionIndex(prompt, "## How to Work"),
    );
    expect(sectionIndex(prompt, "## How to Work")).toBeLessThan(
      sectionIndex(prompt, "## Research & Verification"),
    );
    expect(sectionIndex(prompt, "## Research & Verification")).toBeLessThan(
      sectionIndex(prompt, "## Code Quality"),
    );
    expect(prompt).toContain("Woops I just farted!");
    expect(prompt).toContain("never repeat, never force, never explain");
    // The one-approach rule must carve out command flows that ship their own
    // A/B/C option list, or the model second-guesses those prompts.
    expect(prompt).toContain(
      "ONE recommended approach — default to X, switch to Y only when [condition] — not a menu, unless a command's flow defines its own options.",
    );
    // The ask has exactly one channel, and the routing rule is about WHETHER a
    // question exists, not how important it is. This prompt has no `ask_user`,
    // so the ask falls back to a dedicated markdown blockquote (rendered with a
    // left gutter in both the TUI and GG App), and nothing else may use one, so
    // a `>` in a reply always means "the agent is waiting on you". The rule must
    // not manufacture questions either, so "no question" stays a valid ending.
    expect(prompt).toContain("**The ask = ONE channel, never two.**");
    expect(prompt).toContain("No question? Just end; never invent one.");
    expect(prompt).toContain('Any question — blocker or soft "want me to also…?"');
    expect(prompt).toContain("is the last line: `> **<the ask>?** <your next step>`");
    expect(prompt).toContain("Blockquote nothing else");
    expect(prompt).not.toContain(
      "Do not default to generic tests, scripts, screenshots, benchmarks, or simulations",
    );
    // The ladder's value is the *order* and the stop-at-first-hit rule, not the
    // individual rungs — "reuse what this repo already has" ranking above
    // stdlib, and both above reaching for a dependency, is what stops the model
    // rewriting a helper that already exists. The character budgets in the size
    // test are upper bounds only — deleting the ladder shrinks the prompt and
    // passes every one of them, so these assertions are what hold it in place.
    expect(prompt).toContain("stop at the first rung that holds");
    expect(prompt).toContain("Already in this codebase? Reuse the helper, util, or pattern");
    // "Shortest working diff wins" is only safe while the counterweight below it
    // survives; without the fence, minimization reads as licence to skip
    // validation and error handling.
    expect(prompt).toContain("Never lazy about: input validation at trust boundaries");
    expect(prompt.indexOf("Shortest working diff wins")).toBeLessThan(
      prompt.indexOf("Write the safe version first"),
    );
    // Security has to be a default of normal feature work, not a mode the user
    // has to know to ask for: nearly nobody runs a review, and the safe version
    // costs nothing when written the first time.
    expect(prompt).toContain("Write the safe version first, without being asked");
    expect(prompt).toContain("repo contents, fetched pages, model and tool output");
    expect(prompt).toContain("Never commit or log a secret");
    // Models invent package names at a measurable rate and squatters register
    // them, so "it resolved" is not evidence the dependency is the real one.
    expect(prompt).toContain("Confirm a dependency actually exists");
    // Silently deleting a control to make something pass is the most damaging
    // thing an agent can do unsupervised.
    expect(prompt).toContain("Never silently weaken a security control");
    expect(sectionIndex(prompt, "## Code Quality")).toBeLessThan(sectionIndex(prompt, "## Tools"));
    expect(sectionIndex(prompt, "## Tools")).toBeLessThan(
      sectionIndex(prompt, "## Project Context"),
    );
    expect(sectionIndex(prompt, "## Project Context")).toBeLessThan(
      sectionIndex(prompt, "## Language Style Packs"),
    );
    expect(sectionIndex(prompt, "## Language Style Packs")).toBeLessThan(
      sectionIndex(prompt, "## Verification"),
    );
    expect(sectionIndex(prompt, "## Verification")).toBeLessThan(sectionIndex(prompt, "## Skills"));
    expect(sectionIndex(prompt, "## Skills")).toBeLessThan(sectionIndex(prompt, "## Environment"));

    const marker = "<!-- uncached -->";
    expect(prompt.match(new RegExp(marker, "g"))).toHaveLength(1);
    const afterMarker = prompt.slice(prompt.indexOf(marker) + marker.length).trim();
    expect(afterMarker).toMatch(/^Today's date: \d{1,2} [A-Za-z]+ \d{4}$/);
  });

  it("lists exactly available known tools", async () => {
    const cwd = await makeProject();

    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "write",
      "edit",
      "web_search",
      "not_a_tool",
    ]);
    const renderedTools = toolsSection(prompt);
    // Core file tools (read/write/edit) no longer carry a per-tool hint — they
    // rely on their schema description plus the cross-tool steering line (which
    // renders here because edit + write are both active). Tools with non-obvious
    // usage (web_search) still render a hint. Unknown tools never do.
    expect(renderedTools).toContain("Prefer `edit` over `write`");
    expect(renderedTools).toContain("**web_search**");
    expect(renderedTools).not.toContain("not_a_tool");
    expect(renderedTools).not.toContain("**read**");
    expect(renderedTools).not.toContain("**edit**");
  });

  it("drops the blockquote ask template entirely once `ask_user` is registered", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "edit",
      "ask_user",
    ]);

    // The regression this locks: the reply ended on "Want me to trace X?" in a
    // blockquote while the clickable card was never built. Showing the model a
    // ready-made prose template for the ask is enough for it to reach for one,
    // so with the tool registered NO blockquote form may appear in the prompt.
    expect(prompt).toContain("**Every ask is an `ask_user` call — never a sentence.**");
    // Carried over from the pre-split assertions so the branch swap lost no
    // coverage: the "no second channel" clause must hold in this branch too.
    expect(prompt).toContain("no asking line, no blockquote, no options restated as text");
    expect(prompt).toContain("Offering optional follow-up work counts as a question.");
    expect(prompt).toContain("No question? Just end; never invent one.");
    expect(prompt).not.toContain("the ask is the last line");
    expect(prompt).not.toContain("Blockquote nothing else");
    expect(prompt.match(/`> \*\*/g) ?? []).toHaveLength(0);
    expect(prompt.match(/^\s*`?> /gm) ?? []).toHaveLength(0);
  });

  it("keeps the reply-shape rules free of contradictions", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, ["read", "edit"]);
    const talk = prompt.slice(
      sectionIndex(prompt, "## How to Talk"),
      sectionIndex(prompt, "## How to Work"),
    );

    // "never ask permission" and "end with the ask" only coexist if the ask is
    // gated by one stop list. How to Work owns it; How to Talk must defer to it
    // instead of publishing a second, drifting list of reasons to stop.
    expect(talk).toContain("When something in How to Work genuinely stops you");
    expect(prompt).toContain("Stop only for user decisions, secrets/access, cost");

    // The blockquote is the ask and only the ask, so exactly one blockquote
    // template may exist anywhere in the prompt — a second one teaches the model
    // that `>` is general formatting and the "you're up" signal dies.
    expect(prompt.match(/^\s*`?> /gm) ?? []).toHaveLength(0);
    expect(prompt.match(/`> \*\*/g) ?? []).toHaveLength(1);

    // The budget is the whole reply or it is nothing. Every earlier version
    // carved out the parts that actually carried the bloat (step lists, the
    // ask, batched question lists), so a 900-word reply satisfied every rule.
    // These assertions keep the cap total and the escape hatches deleted.
    expect(talk).toContain("Prose, lists, headers, the ask — everything counts, nothing is exempt");
    expect(talk).toContain("each with your pick, inside the budget");
    expect(talk).not.toContain("prose only; a step list or the ask doesn't count");
    expect(talk).not.toContain("exempt from the reply and list caps");
    expect(talk).not.toContain("Question lists are payload");
    // "exempt" survives in exactly one place: the line that denies exemptions.
    expect(talk.match(/exempt/g) ?? []).toHaveLength(1);

    // Cutting How to Talk was the point: it competes with the task for the
    // model's attention, so the meta-instructions stay smaller than the reply
    // budget they enforce is generous.
    expect(talk.split(/\s+/).filter(Boolean).length).toBeLessThan(360);

    // Mid-turn speech and the cut rule must agree: a bare "finding" cannot both
    // trigger a message and be cut for not changing the next move.
    expect(talk).toContain("speak only when the plan changes");
    expect(talk).not.toContain("unless you hit a decision, tradeoff, finding");
  });

  it("states rule precedence exactly once and keeps project context before style packs", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "Use tabs for this fixture.",
      "tsconfig.json": "{}",
    });

    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      new Set<LanguageId>(["typescript"]),
    );

    // Precedence lives in How to Work only — not restated in Project Context or Style Packs.
    expect(prompt).toContain("Rule precedence: project context files");
    expect(prompt.match(/Rule precedence/g)).toHaveLength(1);
    expect(prompt).not.toContain("**Highest precedence**");
    expect(prompt).not.toContain("override default guidance");
    expect(prompt).not.toContain("override these defaults");
    expect(sectionIndex(prompt, "## Project Context")).toBeLessThan(
      sectionIndex(prompt, "## Language Style Packs"),
    );
  });

  it("renders normal mode as direct coding mode", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "edit",
      "write",
      "bash",
      "subagent",
    ]);

    expect(prompt).toContain("works directly in the user's codebase");
    expect(prompt).toContain("completing tasks end-to-end");
  });

  it("preserves critical operating rules concisely", async () => {
    const cwd = await makeProject({ "AGENTS.md": "Project rules win." });
    const prompt = await buildSystemPrompt(cwd, undefined, true, undefined, [
      "read",
      "edit",
      "write",
      "bash",
      "web_search",
      "web_fetch",
      "source_path",
      "steroids",
    ]);

    for (const required of [
      "works directly in the user's codebase",
      "completing tasks end-to-end",
      "**Budget: ~120 words, whole reply.**",
      "everything counts, nothing is exempt",
      "**One line per item, ≤15 words, max 5 items.**",
      "Take every safe, reversible step the goal implies",
      "never ask permission, merely suggest it, or leave it for the user",
      "ONE action that unblocks you",
      "what already works so finished work is never buried",
      "conclusion, not investigation",
      // Jargon is opt-in, not default: an identifier only earns a mention when
      // the user has to act on it, and then it carries its stake in the same
      // breath. Everything else is described by behavior, not by name.
      "**Plain words by default.**",
      "only when the user must act on it",
      "say what it does, not what it's called",
      "Read before `edit`/`write`",
      "re-read after formatters",
      "Compute in bash; write with `edit`/`write`",
      "Match neighbors",
      "When none exist, infer from the task and project",
      "ask only when a missing product or taste decision would materially change the result",
      "Keep edits small",
      "plan only complex/risky multi-file work",
      "Stop only for user decisions, secrets/access, cost",
      "otherwise continue through completion",
      "Preserve user work",
      "Rule precedence: project context files",
      "file/module patterns → applicable skill instructions",
      "Your training data has a cutoff",
      "treat it as a stale hint to verify, never as ground truth",
      "Do not rely on memory for APIs",
      "Use `source_path`",
      "web_search` then `web_fetch",
      "`steroids` (local corpus of real, current repos) is the source of truth for HOW to build",
      "Build from real samples, not assumptions",
      "Local corpus of real, current open-source repos",
      "regex, NOT semantic",
      "Topic not covered = corpus gap",
      "Skip checks after simple edits",
      "At coherent checkpoints or after risky/non-obvious changes",
      "run one targeted check",
      // Guardrails added in the 2026-08 prompt audit (P1/P2):
      "A question is not a fix request",
      "only when the user explicitly asks — never update git config or force-push",
      "Never revert or reset changes you did not make",
      "reproduce it first",
      "If the same fix fails three times, stop retrying",
      "Never make a failing check pass by weakening it",
      "never fork them into variants",
      "exercise real code paths rather than mocks",
      // Facts-vs-decisions + batched questions (alignment guardrails):
      // asking is sanctioned for decisions only, and asking well means one
      // batched, recommendation-annotated list instead of an interrogation drip.
      "only decisions (taste, product calls, real tradeoffs) reach the user",
      "Several: one numbered list, each with your pick",
    ]) {
      expect(prompt).toContain(required);
    }

    expect(prompt).not.toContain("doable in under 2 minutes");
    expect(prompt).not.toContain("Estimate time only when");
    expect(prompt).not.toContain("plan multi-file work first");
    expect(prompt).not.toContain("otherwise follow through and verify");
    expect(prompt).not.toContain("Run only targeted verification needed for the change");
  });

  it("keeps steroids guidance concise: regex search, symbol lookup, corpus-gap rule", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, ["steroids"]);
    const tools = toolsSection(prompt);

    expect(tools).toContain("Local corpus of real, current open-source repos");
    expect(tools).toContain("regex, NOT semantic");
    expect(tools).toContain("`define` for where a symbol lives");
    expect(tools).toContain("Topic not covered = corpus gap");
    expect(tools).toContain("don't retry variants");
    expect(tools.length).toBeLessThan(600);
  });

  it("makes steroids the proactive source of truth before planning and coding", async () => {
    const cwd = await makeProject();
    const normal = await buildSystemPrompt(cwd, undefined, false, undefined, ["steroids"]);
    expect(normal).toContain("source of truth for HOW to build");
    expect(normal).toContain("before your first `edit`/`write`, and without being asked");
    expect(normal).toContain("NOT permission to write from memory");
    expect(normal).toContain("propose the found repos via `ask_user`, `add` on approval");

    const plan = await buildSystemPrompt(cwd, undefined, true, undefined, ["steroids"]);
    expect(plan).toContain("Ground the approach in real code BEFORE drafting");
    expect(plan).toContain("indexing is allowed in plan mode");

    // Never name a tool the model can't call; instead nudge the user to install
    // the corpus once, and keep going from docs/dependency source.
    const noCorpus = await buildSystemPrompt(cwd, undefined, true, undefined, ["read", "bash"]);
    expect(noCorpus).not.toContain("BEFORE drafting");
    expect(noCorpus).toContain(
      "Agent Steroids (local corpus of real, current repos) is NOT installed",
    );
    expect(noCorpus).toContain("Tip: install Agent Steroids (Home screen → Steroids button)");

    // Corpus present but discover finds nothing (or user declines): fall back
    // honestly rather than stall or fake certainty.
    expect(normal).toContain("say the approach is unverified against real usage");
    expect(plan).toContain("flag the plan as unverified against real usage");
  });

  it("routes public-code research guidance through tool_search when MCP tools are deferred", async () => {
    const cwd = await makeProject();
    // No steroids binary on this machine, tool_search is active.
    const deferred = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "bash",
      "tool_search",
    ]);
    // Research section must not name tools the model can't call yet…
    expect(deferred).not.toContain("source of truth for HOW to build");
    // …and must point discovery at tool_search instead (research + tools hint).
    expect(deferred).toContain("call `tool_search` first");
    expect(deferred).toContain("Check the catalog BEFORE concluding");

    // Neither steroids nor tool_search active: the public-code sentence is omitted.
    const bare = await buildSystemPrompt(cwd, undefined, false, undefined, ["read", "bash"]);
    expect(bare).not.toContain("source of truth for HOW to build");
    expect(bare).not.toContain("tool_search");
  });

  it("measures representative system prompt sizes", async () => {
    const normalCwd = await makeProject();
    const normalToolNames = [
      "read",
      "grep",
      "find",
      "ls",
      "web_search",
      "web_fetch",
      "source_path",
      "steroids",
    ];
    const normalPrompt = await buildSystemPrompt(
      normalCwd,
      undefined,
      false,
      undefined,
      normalToolNames,
    );

    const planModePrompt = await buildSystemPrompt(
      normalCwd,
      undefined,
      true,
      undefined,
      normalToolNames,
    );

    const typescriptCwd = await makeProject({
      "AGENTS.md": "Prefer strict TypeScript. Run the focused test before reporting completion.",
      "package.json": JSON.stringify({
        scripts: {
          test: "vitest",
          typecheck: "tsc --noEmit",
        },
        devDependencies: {
          typescript: "^5.0.0",
          vitest: "^3.0.0",
        },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    });
    const typescriptPrompt = await buildSystemPrompt(
      typescriptCwd,
      [
        {
          name: "find-skills",
          description: "Find and install agent skills from the open ecosystem.",
          content: "Use this when the user asks whether a skill exists for a task.",
          source: "test-fixture",
        },
      ],
      false,
      undefined,
      [
        "read",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        "web_search",
        "web_fetch",
        "source_path",
        "skill",
        "steroids",
      ],
      new Set<LanguageId>(["typescript"]),
    );

    const measurements = {
      normal: promptSize(normalPrompt),
      planMode: promptSize(planModePrompt),
      typescriptProjectContextToolsSkills: promptSize(typescriptPrompt),
    };

    console.info(`system prompt size measurements: ${JSON.stringify(measurements)}`);

    // Budget raised once for the "How to Talk" reply-shape rules (blockquote
    // ask, cut-what-they-can't-act-on, jargon stakes); overlapping lines were
    // folded to pay for part of it. ~640 chars of cached prefix buys replies the
    // user can act on without re-reading.
    //
    // Raised again (~490 chars) for the always-on security defaults in Code
    // Quality. The `bulletproof` skill only fires when the model routes to it,
    // and almost no user asks for a security review before shipping — so the
    // controls that must hold on every edit (hostile input, parameterized
    // queries, secrets, dependency existence, never weakening a control) have
    // to live in the prefix instead. Keep these caps tight so drift stays
    // deliberate.
    //
    // Raised again (~1.6k chars) for the Code Quality minimization ladder.
    // This spend is the rare one that pays for itself inside the same budget:
    // A/B benchmarked at 5 iterations per cell with every generated artifact
    // executed against functional tests, the ladder held correctness flat
    // (100% exec pass, no new dependencies, no turn-cap hits) while cutting
    // generated code 50–76% and output tokens 21–38%. Input tokens fell too,
    // despite the longer prefix: stopping at the first rung that holds costs
    // fewer turns than re-deriving an over-built solution.
    // Raised with the 2026-08 guardrail additions (git safety, anti-fake-green,
    // reproduce-first, circuit-breaker, question-vs-fix, no-variants, test
    // guidance) — each line field-verified as load-bearing across Tier-1 agents.
    // Lowered when the public-code MCP sentence became the shorter native
    // `steroids` staple in Research (actions + build-from-samples philosophy).
    // Raised for the alignment guardrails (facts-vs-decisions sorting,
    // batched questions with recommended answers) — misalignment is the most
    // common failure mode, and these two lines are the always-on floor the
    // `clarify` skill then deepens on demand.
    // Raised for the proactive steroids rule (ground plans and code in real
    // code first; fill the corpus on approval; honest fallback when the corpus
    // is missing or has no fit). The blunt wording ("HARD RULE", "NOT
    // permission to write from memory", verbatim install tip) is what moved
    // GLM-5.3 from 0/3 to 3/3 on the gap and not-installed scenarios in
    // experiments/prompt-bench/steroids-bench.ts — the softer draft scored 0.
    expect(measurements.normal.characters).toBeLessThan(9_300);
    expect(measurements.planMode.characters).toBeLessThan(11_000);
    expect(measurements.typescriptProjectContextToolsSkills.characters).toBeLessThan(13_700);
    expect(measurements.planMode.characters).toBeGreaterThan(measurements.normal.characters);
    expect(measurements.typescriptProjectContextToolsSkills.characters).toBeGreaterThan(
      measurements.normal.characters,
    );
  });

  it("audits representative prompts for obsolete, duplicate, or contradictory guidance", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "Prefer project-specific rules.",
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "tsconfig.json": "{}",
    });
    const prompt = await buildSystemPrompt(
      cwd,
      [{ name: "find-skills", description: "Find skills.", content: "", source: "test" }],
      false,
      undefined,
      [
        "read",
        "edit",
        "write",
        "bash",
        "web_search",
        "web_fetch",
        "source_path",
        "skill",
        "steroids",
      ],
      new Set<LanguageId>(["typescript"]),
    );

    const audit = promptAudit(prompt);
    console.info(`system prompt audit: ${JSON.stringify(audit)}`);

    expect(audit.flags).toEqual([]);
    // Raised with the Code Quality minimization ladder — see the size-budget
    // test above for the measured return that justifies the spend.
    // Raised again with the 2026-08 guardrail additions (see size-budget test).
    // Lowered for the shorter native steroids staple sentence in Research.
    // And again for the alignment guardrails (see size-budget test).
    // And for the proactive steroids rule (see size-budget test).
    expect(audit.size.characters).toBeLessThan(13_400);
    expect(audit.size.sections).toBeGreaterThanOrEqual(8);
  });

  it("only references web_search in Research when it is an active tool", async () => {
    const cwd = await makeProject();

    // Anthropic-shaped tool set: no client-side web_search tool, but native
    // server-side search really exists — the prompt may claim it.
    const anthropicNoSearch = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read", "bash", "web_fetch"],
      undefined,
      "anthropic",
    );
    expect(anthropicNoSearch).not.toContain("web_search");
    expect(anthropicNoSearch).toContain(
      "use `web_fetch` for authoritative docs (native web search is available)",
    );

    // Non-Anthropic provider without the web_search tool: no native-search
    // capability exists, so the prompt must not claim one.
    const otherNoSearch = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read", "bash", "web_fetch"],
      undefined,
      "openai",
    );
    expect(otherNoSearch).not.toContain("web_search");
    expect(otherNoSearch).not.toContain("native web search is available");
    expect(otherNoSearch).toContain("use `web_fetch` for authoritative docs");

    const withSearch = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "bash",
      "web_search",
      "web_fetch",
    ]);
    expect(withSearch).toContain("use `web_search` then `web_fetch` for authoritative docs");
  });

  it("reports the resolved shell in the Environment section", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, ["read"]);

    // Non-Windows hosts (and Windows with Git Bash) run POSIX bash.
    expect(prompt).toContain("- Shell: bash (POSIX)");
  });

  it("lists additional roots and the network allowlist in the Environment section", async () => {
    const cwd = await makeProject();
    const plain = await buildSystemPrompt(cwd, undefined, false, undefined, ["read"]);
    expect(plain).not.toContain("Additional roots:");
    expect(plain).not.toContain("Network allowlist:");

    const scoped = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      undefined,
      undefined,
      { additionalRoots: ["/work/sdk"], networkAllow: ["*.github.com"] },
    );
    expect(scoped).toContain("- Additional roots: /work/sdk");
    expect(scoped).toContain("- Network allowlist: *.github.com");
  });

  it("states the nearest-wins precedence rule in the project context section", async () => {
    const cwd = await makeProject({ "AGENTS.md": "Project rules." });
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, ["read"]);

    expect(prompt).toContain("Files are ordered broadest → nearest.");
    expect(prompt).toContain("the nearest file wins");
  });

  it("uses the Claude Code identity for Anthropic and GG Coder for other providers", async () => {
    const cwd = await makeProject();
    const anthropic = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      undefined,
      "anthropic",
    );
    const openai = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      undefined,
      "openai",
    );

    expect(anthropic.startsWith("You are Claude Code")).toBe(true);
    expect(anthropic).not.toContain("GG Coder by Ken Kai");
    expect(openai.startsWith("You are GG Coder by Ken Kai")).toBe(true);
    expect(openai).not.toContain("You are Claude Code");
  });

  it("renders the exact approved snapshot after its source file is mutated", async () => {
    const cwd = await makeProject({ ".gg/plans/approved/checkpoint.md": "substituted bytes" });
    const approvedPlanPath = path.join(cwd, ".gg/plans/approved/checkpoint.md");
    const prompt = await buildSystemPrompt(cwd, undefined, false, {
      content: "human-approved bytes",
      approvedPlanPath,
    });

    expect(prompt).toContain("human-approved bytes");
    expect(prompt).not.toContain("substituted bytes");
  });
  it("is byte-stable across builds in one process (prefix-cache safety)", async () => {
    // Deterministic arm of bench/baseline/04-prefix-stability.mjs, promoted to
    // a unit test so a volatile section landing in the cached prefix fails
    // `pnpm test`, not a manual bench run. The live cache-hit e2e
    // (core/provider-cache.e2e.test.ts) guards the same property end-to-end.
    const cwd = await makeProject({
      "CLAUDE.md": "Project rules win.",
      "package.json": JSON.stringify({ scripts: { check: "tsc --noEmit" } }),
    });
    const args = {
      skills: [],
      planMode: false,
      approvedPlanPath: undefined,
      toolNames: ["read", "edit", "bash"],
      activeLanguages: new Set<LanguageId>(["typescript"]),
    };
    const a = await buildSystemPrompt(
      cwd,
      args.skills,
      args.planMode,
      args.approvedPlanPath,
      args.toolNames,
      args.activeLanguages,
    );
    const b = await buildSystemPrompt(
      cwd,
      args.skills,
      args.planMode,
      args.approvedPlanPath,
      args.toolNames,
      args.activeLanguages,
    );
    expect(a).toBe(b);
    // Same for the Ken advisor prompt — its marker must also partition
    // volatile bytes out of the cached prefix (ken-prompt.ts pins the marker
    // as byte-identical to the build prompt's).
    const kenA = await buildKenSystemPrompt(cwd);
    const kenB = await buildKenSystemPrompt(cwd);
    expect(kenA).toBe(kenB);
    for (const prompt of [a, kenA]) {
      expect(prompt).toContain("<!-- uncached -->");
      // All volatile content (currently only the date) sits AFTER the marker.
      const markerAt = prompt.indexOf("<!-- uncached -->");
      expect(prompt.slice(markerAt)).toMatch(/Today's date: \d{1,2} \w+ \d{4}/);
    }
  });
});

describe("collectProjectContext", () => {
  it("picks one file per directory — AGENTS.md shadows CLAUDE.md and the rest", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "agents rules",
      "CLAUDE.md": "claude rules",
      ".cursorrules": "cursor rules",
    });

    const parts = await collectProjectContext(cwd);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("AGENTS.md");
    expect(parts[0]).toContain("agents rules");
    expect(parts.join("\n")).not.toContain("claude rules");
    expect(parts.join("\n")).not.toContain("cursor rules");
  });

  it("AGENTS.override.md beats AGENTS.md in the same directory", async () => {
    const cwd = await makeProject({
      "AGENTS.override.md": "local override rules",
      "AGENTS.md": "checked-in rules",
    });

    const parts = await collectProjectContext(cwd);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("AGENTS.override.md");
    expect(parts[0]).toContain("local override rules");
    expect(parts.join("\n")).not.toContain("checked-in rules");
  });

  it("renders broad → narrow: the nearest file comes last", async () => {
    const root = await makeProject({
      "AGENTS.md": "root-level rules",
      "nested/CLAUDE.md": "nested rules",
    });
    const cwd = path.join(root, "nested");

    const parts = await collectProjectContext(cwd);

    const rendered = parts.join("\n\n");
    expect(rendered.indexOf("root-level rules")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("root-level rules")).toBeLessThan(rendered.indexOf("nested rules"));
    expect(parts[parts.length - 1]).toContain("CLAUDE.md");
  });

  it("skips empty or whitespace-only files", async () => {
    const cwd = await makeProject({ "AGENTS.md": "  \n\t\n" });

    expect(await collectProjectContext(cwd)).toHaveLength(0);
  });

  it("strips a BOM so the content renders clean", async () => {
    const cwd = await makeProject({ "AGENTS.md": "\uFEFFbom rules" });

    const parts = await collectProjectContext(cwd);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("bom rules");
    expect(parts[0]).not.toContain("\uFEFF");
  });

  it("budgets nearest-first at 32 KiB and reports skipped files", async () => {
    const bigParent = "x".repeat(PROJECT_CONTEXT_MAX_BYTES + 1_000);
    const root = await makeProject({
      "AGENTS.md": bigParent,
      "nested/CLAUDE.md": "nearest rules survive",
    });
    const cwd = path.join(root, "nested");

    const parts = await collectProjectContext(cwd);

    const rendered = parts.join("\n\n");
    expect(rendered).toContain("nearest rules survive");
    expect(rendered).not.toContain(bigParent);
    expect(rendered).toContain("Skipped (context budget)");
    expect(rendered).toMatch(/Skipped \(context budget\): .*AGENTS\.md \(\d+KB\)/);
  });

  it("keeps the nearest file when the budget cannot fit both", async () => {
    const nearBig = "n".repeat(PROJECT_CONTEXT_MAX_BYTES - 100);
    const parentRules = `parent rules ${"p".repeat(200)}`; // larger than the 100B leftover
    const root = await makeProject({
      "AGENTS.md": parentRules,
      "nested/AGENTS.md": nearBig,
    });
    const cwd = path.join(root, "nested");

    const parts = await collectProjectContext(cwd);
    const rendered = parts.join("\n\n");

    // The nearest (big) file consumed the budget; the parent was dropped.
    expect(rendered).toContain(nearBig);
    expect(rendered).not.toContain(parentRules);
    expect(rendered).toContain("Skipped (context budget)");
  });
});

describe("buildSubAgentSystemPrompt", () => {
  it("composes the agent body with tools, context, contract and environment", async () => {
    const cwd = await makeProject({ "CLAUDE.md": "Project rules win." });

    const prompt = await buildSubAgentSystemPrompt("You are Owl. Explore this repo.", {
      cwd,
      toolNames: ["read", "grep", "code_search"],
    });

    expect(prompt.startsWith("You are Owl. Explore this repo.")).toBe(true);
    expect(sectionIndex(prompt, "## Tools")).toBeLessThan(
      sectionIndex(prompt, "## Project Context"),
    );
    expect(sectionIndex(prompt, "## Project Context")).toBeLessThan(
      sectionIndex(prompt, "## Report"),
    );
    expect(sectionIndex(prompt, "## Report")).toBeLessThan(sectionIndex(prompt, "## Environment"));
    expect(prompt).toContain("Project rules win.");
    // The volatile date stays behind the cache marker, exactly as the parent's.
    expect(prompt.indexOf("<!-- uncached -->")).toBeGreaterThan(
      sectionIndex(prompt, "## Environment"),
    );
  });

  it("never advertises a tool the child's allow-list strips", async () => {
    const cwd = await makeProject();

    const prompt = await buildSubAgentSystemPrompt("You are Owl.", {
      cwd,
      toolNames: ["read", "grep", "code_search"],
    });

    const toolsSection = prompt.slice(
      sectionIndex(prompt, "## Tools"),
      sectionIndex(prompt, "## Report"),
    );
    expect(toolsSection).toContain("code_search");
    expect(toolsSection).not.toContain("**write**");
    expect(toolsSection).not.toContain("**bash**");
    expect(prompt).not.toContain("## Delegation");
  });

  it("skips project instruction files when the agent opts out of context", async () => {
    const cwd = await makeProject({ "CLAUDE.md": "Project rules win." });

    const prompt = await buildSubAgentSystemPrompt("You are Owl.", {
      cwd,
      toolNames: ["read"],
      context: "none",
    });

    expect(prompt).not.toContain("Project rules win.");
    expect(prompt).toContain("## Environment");
  });

  it("briefs a delegating child on standalone task briefs", async () => {
    const cwd = await makeProject();

    const prompt = await buildSubAgentSystemPrompt("You are Bee.", {
      cwd,
      toolNames: ["read", "subagent"],
    });

    expect(prompt).toContain("## Delegation");
    expect(prompt).toContain("sees none of this conversation");
  });
});

describe("system prompt byte ceiling", () => {
  it("bounds a hostile AGENTS.md + skill catalog by per-input budgets, not the ceiling", async () => {
    const cwd = await makeProject({
      "AGENTS.md": `# Hostile\n\n${"inject ".repeat(20_000)}`, // ~120KB
    });
    const skills = Array.from({ length: 80 }, (_, i) => ({
      name: `skill-${i}`,
      description: "y".repeat(2_000), // 160KB raw descriptions
      content: "x",
      source: "global",
    }));
    const prompt = await buildSystemPrompt(cwd, skills);
    // Per-input budgets do the work: well under the 1MB ceiling regardless.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(64 * 1024);
    expect(prompt).toContain("Skipped (context budget)");
  });

  it("enforces the emergency ceiling when sections overflow it", async () => {
    const cwd = await makeProject({
      "AGENTS.md": `${"a".repeat(31 * 1024)}`, // just under the 32KB file budget
    });
    const prompt = await buildSystemPrompt(
      cwd,
      [],
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveContextLimits({ systemPromptCeilingBytes: 16 * 1024 }),
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(prompt).toContain("system prompt exceeded the 16384-byte ceiling");
  });
});
