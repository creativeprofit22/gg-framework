import fs from "node:fs/promises";
import path from "node:path";
import { formatSkillsForPrompt, type Skill } from "./core/skills.js";
import { clampToBytes, CONTEXT_LIMITS, type ContextLimits } from "./core/context-limits.js";
import { TOOL_PROMPT_HINTS, buildToolSteering, DEFAULT_TOOL_NAMES } from "./tools/prompt-hints.js";
import type { LanguageId } from "./core/language-detector.js";
import { stripBom } from "./utils/text.js";
import { resolveShell } from "./core/shell.js";
import { renderStylePacksSection } from "./core/style-packs/index.js";
import { detectVerifyCommands, renderVerifySection } from "./core/verify-commands.js";
import { detectPlatformClis, renderPlatformClisSection } from "./core/platform-clis.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import type { Provider } from "@kenkaiiii/gg-ai";

// One instruction file per directory, first match wins (Codex-style selection).
// AGENTS.override.md lets a user shadow a checked-in AGENTS.md locally.
const CONTEXT_FILES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "CONVENTIONS.md",
];

/** Combined byte budget for all project instruction files (Codex default). */
export const PROJECT_CONTEXT_MAX_BYTES = CONTEXT_LIMITS.projectContextBytes;
const UNCACHED_MARKER = "<!-- uncached -->";

/**
 * The agent's product identity. Anthropic models run as "Claude Code" (matching
 * the Claude Code identity Anthropic's OAuth tokens require in the system
 * prompt); every other provider runs as GG Coder. Keeping this dynamic avoids a
 * contradictory double identity when streaming through Anthropic.
 */
function productName(provider: Provider | undefined): string {
  return provider === "anthropic" ? "Claude Code" : "GG Coder by Ken Kai";
}

function renderIdentitySection(provider: Provider | undefined): string {
  const name = productName(provider);
  return (
    `You are ${name} — a coding agent that works directly in the user's codebase. ` +
    `You explore, understand, change, and verify code — completing tasks end-to-end ` +
    `rather than just suggesting edits.`
  );
}

/**
 * Reply shape.
 *
 * The budget is stated first and admits no exemptions on purpose. The previous
 * version capped "1–2 sentences, hard cap 5 — prose only" and then exempted
 * step lists, the ask, and question lists from that cap, so a reply could be
 * arbitrarily long while every stated rule held. Bullets absorbed the bloat.
 * One total budget plus a per-item line cap is the only form the model cannot
 * satisfy while still writing an essay.
 */
function renderTalkSection(toolNames: readonly string[] | undefined): string {
  // Two mutually exclusive ask rules. While `ask_user` is registered the
  // blockquote form must not appear in the prompt AT ALL: showing the model a
  // concrete prose template for the ask is an invitation to use it, and the
  // measured failure was exactly that — a soft "want me to also…?" blockquote
  // ending the reply while the card the user can click never got built. The
  // fallback only renders for hosts with no one to answer a question.
  const askRule = (toolNames ?? DEFAULT_TOOL_NAMES).includes("ask_user")
    ? `**Every ask is an \`ask_user\` call — never a sentence.** No question? Just end; never invent one. Any question you'd end on — a blocker OR a soft "want me to also…?" — is a tool call, never prose: no asking line, no blockquote, no options restated as text. Offering optional follow-up work counts as a question. Several: one call, each with your pick marked \`recommended\`.`
    : `**The ask = ONE channel, never two.** No question? Just end; never invent one. Any question — blocker or soft "want me to also…?" — is the last line: \`> **<the ask>?** <your next step>\`. Blockquote nothing else. Several: one numbered list, each with your pick, inside the budget.`;
  return (
    `## How to Talk\n\n` +
    `Write for severe ADHD: fast scanning, low working memory, easy action.\n\n` +
    `**Budget: ~120 words, whole reply.** Prose, lists, headers, the ask — everything counts, nothing is exempt. Over budget means cut content, not compress wording.\n\n` +
    `**First line = actionable state.** Done: the outcome. Blocked or handing off: the ONE next action, plus what already works so finished work is never buried.\n\n` +
    `**One line per item, ≤15 words, max 5 items.** Needs a second line? That's two ideas — cut one. **Bold** the word that matters.\n\n` +
    `**Cut what they can't act on.** Reasoning, findings, and history earn a clause only when they change the next move: conclusion, not investigation; never re-explain yourself.\n\n` +
    `**Plain words by default.** Name a file, symbol, or command only when the user must act on it — then give its stake in the same breath (≤8 words). Otherwise say what it does, not what it's called.\n\n` +
    `**Default to action.** Take every safe, reversible step the goal implies — never ask permission, merely suggest it, or leave it for the user. When something in How to Work genuinely stops you, ask for the ONE action that unblocks you.\n\n` +
    `${askRule}\n\n` +
    `Give ONE recommended approach — default to X, switch to Y only when [condition] — not a menu, unless a command's flow defines its own options. ` +
    `Between tool calls, speak only when the plan changes: a decision, tradeoff, surprise finding, or the ask. No preamble, no recap, no hedging, no output dumps. ` +
    `Surface tradeoffs and unverified claims plainly. Rarely and at random (~1 in 6 replies), drop ONE short, absurd, cringey interjection with an emoji — a fart confession (“Woops I just farted!”), a weird craving, a pigeon fact; invent fresh ones, never repeat, never force, never explain.`
  );
}

function renderWorkSection(): string {
  return (
    `## How to Work\n\n` +
    `- Read before \`edit\`/\`write\`; re-read after formatters, \`lint --fix\`, codemods, codegen, checkout, or any disk mutator.\n` +
    `- Compute in bash; write with \`edit\`/\`write\` so read-tracking, partial apply, and diagnostics stay intact.\n` +
    `- Match neighbors (components/tokens/tone). When none exist, infer from the task and project; ask only when a missing product or taste decision would materially change the result. Keep edits small; plan only complex/risky multi-file work—edit routine changes directly.\n` +
    `- Stop only for user decisions, secrets/access, cost, destructive risk, data loss, or unrelated disruption; otherwise continue through completion.\n` +
    `- Facts vs. decisions: if code, docs, or a run can answer it, it is a fact — find it yourself; only decisions (taste, product calls, real tradeoffs) reach the user.\n` +
    `- A question is not a fix request: when the user asks why something happens, answer it — change code only when they ask for the change.\n` +
    `- Preserve user work: investigate unexpected files, branches, or locks before touching them. \`.gitignore\` generated artifacts, secrets, logs, scratch, and \`.env\`.\n` +
    `- Git: commit, push, amend, or rewrite history only when the user explicitly asks — never update git config or force-push. Never revert or reset changes you did not make; if the worktree holds changes you don't recognize, stop and ask.\n` +
    `- Rule precedence: project context files → file/module patterns → applicable skill instructions → Language Style Packs → this prompt.\n` +
    `- For a requested bug fix, reproduce it first (run the failing test or a minimal repro command), then fix, then re-run the reproduction to confirm.\n` +
    `- If the same fix fails three times, stop retrying: re-diagnose the root cause or propose a different approach.\n` +
    `- Skip checks after simple edits. At coherent checkpoints or after risky/non-obvious changes, run one targeted check; fix failures. Never claim unrun checks passed.`
  );
}

function renderPlanModeSection(): string {
  return (
    `## Plan Mode (ACTIVE)\n\n` +
    `You are in PLAN MODE. Research and design an implementation plan before writing implementation code.\n\n` +
    `### Plan-mode flow\n` +
    `Explore with read/search/docs tools and read-only bash (e.g. \`git log\`, \`git diff\`, \`grep\`, \`wc -l\`, \`find\`, \`cat\`), draft a structured markdown plan at \`.gg/plans/<name>.md\`, then call \`exit_plan\` with that path for user review.\n\n` +
    `### Rules\n` +
    `- Do not implement yet: no code edits outside \`.gg/plans/\`, no mutating bash (read-only shell for exploration is allowed), no subagent, no task orchestration.\n` +
    `- Be specific: list exact file paths, functions, dependencies, risks, and verification criteria.\n` +
    `- ALWAYS end the plan with a heading written exactly as \`## Steps\` (this literal heading is required — not \`## Plan\`, \`## Implementation\`, or any other variant), followed by a flat, ordered, numbered list (\`1.\`, \`2.\`, …) of concrete implementation steps to execute after approval. Each step is one actionable unit of work — not a design note, question, or rejected alternative. This section is the single source of truth for post-approval progress tracking, so only put real, doable steps here.\n` +
    `- Keep investigating until the plan is actionable, then stop after \`exit_plan\`.`
  );
}

export interface ApprovedPlanPromptContent {
  /** Exact immutable content captured when approval committed. */
  content: string;
  /** Display/source metadata only; never read while building the prompt. */
  approvedPlanPath?: string;
}

function renderApprovedPlanSection(
  approvedPlan: ApprovedPlanPromptContent | undefined,
): string | null {
  if (!approvedPlan?.content.trim()) return null;
  const planContent = approvedPlan.content;
  const displaySource = approvedPlan.approvedPlanPath
    ? ` File: ${approvedPlan.approvedPlanPath}`
    : "";
  // The `[DONE:n]` progress contract only applies when `extractPlanSteps`
  // actually finds a step section (a `## Steps` heading or a close synonym).
  // Without it there are no tracked steps, so instructing the model to march
  // through the steps and emit `[DONE:n]` would push it to fabricate progress
  // against content that isn't a task list.
  const hasSteps = extractPlanSteps(planContent).length > 0;
  const stepInstruction = hasSteps
    ? `\n- After each step from \`## Steps\`, output \`[DONE:n]\` (e.g. \`[DONE:1]\`) to update the progress widget, then continue with step n+1 in the same turn.`
    : "";
  return (
    `## Approved Plan\n\n` +
    `Follow this plan strictly.${displaySource}\n\n` +
    `<approved_plan>\n${planContent.trim()}\n</approved_plan>\n\n` +
    `- Follow step order. Don't deviate without user confirmation.` +
    stepInstruction
  );
}

function renderResearchSection(
  toolNames: readonly string[] | undefined,
  provider: Provider | undefined,
): string {
  const active = new Set(toolNames ?? DEFAULT_TOOL_NAMES);
  // Steroids usage details (regex not semantic, corpus-gap rule) live in the
  // Tools section hint — one home, no duplication. Research names the staple
  // with one-line purposes and defers usage to Tools. The tool only exists when
  // the `steroids` binary is on the machine; otherwise point at tool_search
  // discovery instead. Never reference an unavailable tool.
  const publicCode = active.has("steroids")
    ? ` Ground nontrivial code in real usage with the \`steroids\` tool — a local corpus of real repos: \`search\` for exact snippets, \`define\` for where a symbol lives, \`discover\` when the topic isn't covered. Build from real samples, not assumptions.`
    : active.has("tool_search")
      ? ` For public GitHub code and design references, call \`tool_search\` first (e.g. "search public code" or "UI design screens") — it unlocks the matching tools for your next step.`
      : "";
  // Only reference `web_search` when it's actually in the active tool set, and
  // only claim native server-side search on providers that really have it
  // (Anthropic). Naming an unavailable tool or capability trains the model to
  // rely on something that doesn't exist.
  const docs = active.has("web_search")
    ? `use \`web_search\` then \`web_fetch\` for authoritative docs`
    : provider === "anthropic"
      ? `use \`web_fetch\` for authoritative docs (native web search is available)`
      : `use \`web_fetch\` for authoritative docs`;
  const dependencySource = active.has("source_path")
    ? `Use \`source_path\` for installed deps`
    : active.has("tool_search")
      ? `Call \`tool_search\` to load \`source_path\` before inspecting installed deps`
      : `Inspect installed dependency source when available`;
  return (
    `## Research & Verification\n\n` +
    `Your training data has a cutoff; the real current date is the final line of this prompt. Assume your knowledge of library versions, APIs, CLI flags, config schema, defaults, and best practices has changed since then — treat it as a stale hint to verify, never as ground truth. ` +
    `Do not rely on memory for APIs, CLI flags, config schema, internals, or error wording — verify first. ${dependencySource}; ${docs}.` +
    publicCode
  );
}

/**
 * Code quality, led by an explicit minimization ladder.
 *
 * The ladder is ordered and stop-at-first-hit on purpose: the measured failure
 * mode is not bad code, it is *more* code than the task needed — unrequested
 * abstractions, options nobody asked for, a dependency where a native call
 * would do. Stating the rungs as a sequence converts that judgement into a
 * checklist the model actually runs before writing.
 *
 * Benchmarked against the previous prose-only version (A/B, 5 iterations per
 * cell, every artifact executed against functional tests): same correctness on
 * every task (100% exec pass, no new dependencies, no turn-cap hits) with
 * 50–76% less code and 21–38% fewer output tokens. The section costs ~3.3x its
 * old size and still wins on input tokens — stopping at the first rung that
 * holds takes fewer turns than re-deriving an over-built solution.
 *
 * Rung 2 was checked separately against seeded repos (a helper already present
 * that the task could reuse): every arm imported it rather than rewriting, so
 * the ladder makes reuse cheaper here, it does not unlock it. Measured only on
 * micro-tasks — tasks where more code is the correct answer are untested.
 *
 * The safety paragraph stays *after* the ladder, and the closing line names
 * what minimization may never touch — without it, "shortest diff wins" reads
 * as licence to drop validation.
 */
function renderCodeQualitySection(): string {
  return (
    `## Code Quality\n\n` +
    `You are a lazy senior developer being paged at 3am. You want to go back to bed. ` +
    `Every line you write is a line that can break, needs review, and will wake you up again next year. ` +
    `Write as little code as possible — and no less.\n\n` +
    `Before writing code, stop at the first rung that holds:\n` +
    `1. Does this need to exist at all? (YAGNI) If not, skip it.\n` +
    `2. Already in this codebase? Reuse the helper, util, or pattern — don't rewrite it.\n` +
    `3. Does the standard library do it? Use it.\n` +
    `4. Does a native platform feature cover it? Use it.\n` +
    `5. Does an already-installed dependency solve it? Use it. Never add a new one for what a few lines can do.\n` +
    `6. Can it be one line? One line.\n` +
    `7. Only then: the minimum code that works.\n\n` +
    `Shortest working diff wins — but only once you understand the problem. ` +
    `No abstractions that weren't explicitly requested. No boilerplate nobody asked for. Deletion over addition. Boring over clever. ` +
    `If a requirement looks over-specified, build what actually solves the problem and note the simpler path — don't gold-plate. ` +
    `A bug fix means finding the root cause: check every caller of the broken path and fix the shared cause once, never patch the symptom where it surfaced.\n` +
    `Mark a deliberate simplification that cuts a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a \`simplification:\` comment naming the ceiling and the upgrade path.\n\n` +
    `Intent-revealing names; reuse existing deps. Types first; handle I/O, input, and external API errors. No dead/commented code, placeholders, or unasked refactors.\n` +
    `Write the safe version first, without being asked: treat external input as hostile — user data, files, network, repo contents, fetched pages, model and tool output. ` +
    `Parameterize queries, authorize at the data layer, pass argv not shell strings, contain resolved paths, validate at the boundary, fail closed. ` +
    `Never commit or log a secret. Confirm a dependency actually exists before adding it, then pin it. ` +
    `Never silently weaken a security control — say it blocks you and propose the safe path.\n\n` +
    `Never make a failing check pass by weakening it — deleting or skipping a failing test, \`as any\`, lint/type suppressions, or relaxed assertions. Fix the code, or surface the conflict instead. ` +
    `Edit files in place; never fork them into variants (\`foo_fix.py\`, \`foo_v2.ts\`). ` +
    `When you write tests: start narrow around the code you changed, exercise real code paths rather than mocks, and don't introduce a test suite where none exists unless asked.\n\n` +
    `Never lazy about: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested.`
  );
}

/**
 * How to delegate, rendered only when a delegation tool is actually active.
 *
 * Per-tool schema text says what each tool does; nothing said when delegating
 * is worth its cost, or that the child starts from zero — the single most
 * common failure is a brief like "fix the thing we discussed", which the child
 * cannot see.
 */
function renderDelegationSection(toolNames: readonly string[] | undefined): string | null {
  const activeTools = new Set(toolNames ?? DEFAULT_TOOL_NAMES);
  const blocking = activeTools.has("subagent");
  const async = activeTools.has("spawn_agent");
  if (!blocking && !async) return null;

  const lines = [
    `Delegate when a task needs its own context: wide search, an independent workstream, or work you'd otherwise interleave badly. Don't delegate what you can finish inline — a child costs a process, a cold cache, and a round trip.`,
    `**A child sees none of this conversation.** Its task brief is all it gets, so state the objective, the concrete paths/symbols involved, the constraints, and what to return. "Continue what we discussed" gets you nothing back.`,
    `One agent per independent unit of work. Overlapping briefs produce duplicated effort and contradictory answers.`,
    `Pick the named agent whose description matches the work; leave \`agent\` unset only when none fits.`,
    `You own the result: a child's report is evidence, not truth. Verify anything you're about to act on.`,
  ];
  if (async && blocking) {
    lines.push(
      `\`subagent\` blocks until the child answers; \`spawn_agent\` returns immediately and the child announces its own completion — use it to fan out, then keep working.`,
    );
  }
  return `## Delegation\n\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * Render the Tools section.
 *
 * `deferredToolNames` are tools that exist but whose parameter schemas are held
 * out of the request until `tool_search` promotes them. They get a one-line
 * capability hint under their own sub-heading: without it the model cannot
 * search for what it does not know exists, and deferral would trade tokens for
 * capability blindness. Steering clauses see both tiers, since a preference
 * like "use X rather than Y" stays true while X is one `tool_search` away.
 */
function renderToolsSection(
  toolNames: readonly string[] | undefined,
  deferredToolNames?: readonly string[],
): string | null {
  const activeTools = toolNames ?? DEFAULT_TOOL_NAMES;
  const deferred = (deferredToolNames ?? []).filter((name) => !activeTools.includes(name));
  const toolLines: string[] = [];
  for (const name of activeTools) {
    const hint = TOOL_PROMPT_HINTS[name];
    if (hint) toolLines.push(`- **${name}**: ${hint}`);
  }
  const deferredLines: string[] = [];
  for (const name of deferred) {
    const hint = TOOL_PROMPT_HINTS[name];
    if (hint) deferredLines.push(`- **${name}**: ${hint}`);
  }
  // Cross-tool steering: each clause renders only when its tools are active.
  // Per-tool hints only exist for tools with non-obvious usage (see prompt-hints).
  const steering = buildToolSteering([...activeTools, ...deferred]);
  const parts: string[] = [];
  if (steering) parts.push(steering);
  if (toolLines.length > 0) parts.push(toolLines.join("\n"));
  if (deferredLines.length > 0) {
    parts.push(`Available on demand (call \`tool_search\` to load):\n${deferredLines.join("\n")}`);
  }
  return parts.length > 0 ? `## Tools\n\n${parts.join("\n\n")}` : null;
}

/**
 * Deterministic hierarchical instruction resolver.
 *
 * Walks from cwd up to the filesystem root picking at most ONE instruction
 * file per directory (CONTEXT_FILES priority order, first match wins), skips
 * empty files, strips BOMs, and renders root-first (broad → narrow) so the
 * nearest file lands last — where LLM recency bias weights it most. A 32 KiB
 * combined budget is filled nearest-first (the nearest instructions are the
 * most binding); files dropped by the cap are reported in a one-line note.
 */
export async function collectProjectContext(
  cwd: string,
  limits: ContextLimits = CONTEXT_LIMITS,
): Promise<string[]> {
  // Nearest-first collection order (cwd → root).
  const collected: Array<{ relPath: string; content: string; bytes: number }> = [];
  let dir = cwd;
  const visited = new Set<string>();

  while (!visited.has(dir)) {
    visited.add(dir);
    for (const name of CONTEXT_FILES) {
      const filePath = path.join(dir, name);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue; // File doesn't exist — try the next candidate name.
      }
      const trimmed = stripBom(content).trim();
      const relPath = path.relative(cwd, filePath) || name;
      // Empty/whitespace-only files still claim the directory slot — an empty
      // AGENTS.override.md deliberately silences the directory's instructions.
      if (trimmed) {
        collected.push({ relPath, content: trimmed, bytes: Buffer.byteLength(trimmed, "utf-8") });
      }
      break; // One file per directory — first match wins.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Budget nearest-first: the closest files are the most binding.
  let budget = limits.projectContextBytes;
  const kept = new Set<number>();
  const skipped: string[] = [];
  for (let i = 0; i < collected.length; i++) {
    const file = collected[i];
    if (file.bytes <= budget) {
      kept.add(i);
      budget -= file.bytes;
    } else {
      skipped.push(`${file.relPath} (${Math.round(file.bytes / 1024)}KB)`);
    }
  }

  // Render root-first (broad → narrow): reverse of collection order.
  const contextParts: string[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    if (!kept.has(i)) continue;
    const file = collected[i];
    contextParts.push(`### ${file.relPath}\n\n${file.content}`);
  }
  if (skipped.length > 0) {
    contextParts.push(`_Skipped (context budget): ${skipped.join(", ")}_`);
  }

  return contextParts;
}

function renderProjectContextSection(contextParts: readonly string[]): string | null {
  if (contextParts.length === 0) return null;
  return (
    `## Project Context\n\n` +
    `Files are ordered broadest → nearest. On conflict, the nearest file wins; explicit user instructions win over all files.\n\n` +
    contextParts.join("\n\n")
  );
}

/** Extra Environment-section facts that vary per session rather than per host. */
export interface SystemPromptEnvironment {
  /** Extra workspace roots added with `/add-dir`. */
  additionalRoots?: readonly string[];
  /** Hosts the network allowlist permits, when `networkMode` is `allowlist`. */
  networkAllow?: readonly string[];
}

function renderEnvironmentSection(cwd: string, environment?: SystemPromptEnvironment): string {
  // Static per host, so it lives in the cached prompt body: which shell bash
  // commands actually execute under (cmd.exe fallback on bash-less Windows).
  const shellLine = resolveShell("").isCmdFallback
    ? "- Shell: cmd.exe (no bash found)"
    : "- Shell: bash (POSIX)";
  const lines = [`- Working directory: ${cwd}`];
  const roots = environment?.additionalRoots ?? [];
  if (roots.length > 0) {
    // Added with /add-dir: tools take absolute paths into these roots and
    // writes there are allowed.
    lines.push(`- Additional roots: ${roots.join(", ")}`);
  }
  lines.push(`- Platform: ${process.platform}`, shellLine);
  const allow = environment?.networkAllow ?? [];
  if (allow.length > 0) {
    lines.push(`- Network allowlist: ${allow.join(", ")} (other hosts are blocked)`);
  }
  return `## Environment\n\n${lines.join("\n")}`;
}

function renderUncachedDateSuffix(): string {
  const today = new Date();
  const day = today.getDate();
  const month = today.toLocaleString("en-US", { month: "long" });
  const year = today.getFullYear();
  return `${UNCACHED_MARKER}\nToday's date: ${day} ${month} ${year}`;
}

/**
 * Emergency ceiling on the assembled prompt. Normal prompts are 15–25 KB; a
 * hostile AGENTS.md stack plus a bloated skill catalog is the threat. Every
 * individual input is already budgeted upstream — this is the backstop that
 * bounds the total no matter what a future section adds.
 */
function enforcePromptCeiling(prompt: string, ceilingBytes: number): string {
  if (Buffer.byteLength(prompt, "utf8") <= ceilingBytes) return prompt;
  const marker = `\n[system prompt exceeded the ${ceilingBytes}-byte ceiling and was truncated]`;
  return `${clampToBytes(prompt, ceilingBytes - Buffer.byteLength(marker, "utf8")).text}${marker}`;
}

/**
 * What every sub-agent owes its parent.
 *
 * Appended by `buildSubAgentSystemPrompt`, so user-authored agent files inherit
 * it without repeating it. The parent pays context for whatever comes back, and
 * it cannot see the child's transcript — so the reply has to be the answer, not
 * a narration of the search that produced it.
 */
export const SUBAGENT_RETURN_CONTRACT =
  `## Report\n\n` +
  `You are a sub-agent. Your reply is the ONLY thing your caller receives — it never sees your tool calls, your reasoning, or the files you opened.\n\n` +
  `- Lead with the answer or the outcome. No preamble, no recap of your process.\n` +
  `- Cite evidence as \`file:line\`. Point at paths; never paste file bodies or command output the caller can re-read.\n` +
  `- State what you actually verified and how (command run, test executed, file read). Never claim a check you did not run.\n` +
  `- Name blockers, assumptions, and anything you could not confirm, plainly.\n` +
  `- Stay under ~400 words. If the finding is genuinely larger, write it to a file and return the path.`;

/**
 * Build a sub-agent's system prompt: its own definition PLUS the scaffolding
 * that teaches correct tool use.
 *
 * An agent definition body replaces the parent's Identity/Talk/Work sections —
 * that is the point of a specialized agent. It must NOT also cost the child its
 * Tools section, project conventions, or Environment facts (cwd, platform,
 * shell, date), which is what a bare prompt override did: children ran blind to
 * their own toolset and re-derived basics every session.
 *
 * @param agentBody — the agent definition's markdown body (its identity + method).
 * @param opts.toolNames — exactly the tools this child can call, so the Tools
 *   section never advertises something the allow-list strips.
 * @param opts.context — `"none"` skips project instruction files, for recon
 *   agents where conventions are dead weight.
 */
export async function buildSubAgentSystemPrompt(
  agentBody: string,
  opts: {
    cwd: string;
    toolNames?: readonly string[];
    /** Tools available via `tool_search` but not carrying a schema this turn. */
    deferredToolNames?: readonly string[];
    context?: "project" | "none";
    environment?: SystemPromptEnvironment;
    /** Byte budgets for skill catalog / project instructions / total ceiling. */
    contextLimits?: ContextLimits;
  },
): Promise<string> {
  const limits = opts.contextLimits ?? CONTEXT_LIMITS;
  const sections: string[] = [agentBody.trim()];

  const toolsSection = renderToolsSection(opts.toolNames, opts.deferredToolNames);
  if (toolsSection) sections.push(toolsSection);

  // A child may itself delegate (up to the nesting limit), so it needs the same
  // briefing rules whenever a delegation tool survived its allow-list.
  const delegationSection = renderDelegationSection(opts.toolNames);
  if (delegationSection) sections.push(delegationSection);

  if ((opts.context ?? "project") === "project") {
    const projectContextSection = renderProjectContextSection(
      await collectProjectContext(opts.cwd, limits),
    );
    if (projectContextSection) sections.push(projectContextSection);
    const platformClis = renderPlatformClisSection(detectPlatformClis(opts.cwd));
    if (platformClis) sections.push(platformClis);
  }

  sections.push(
    SUBAGENT_RETURN_CONTRACT,
    // Environment + date stay last so the cached prefix matches the parent's
    // layout: everything above is stable, the date suffix is the uncached tail.
    renderEnvironmentSection(opts.cwd, opts.environment),
    renderUncachedDateSuffix(),
  );

  return enforcePromptCeiling(sections.join("\n\n"), limits.systemPromptCeilingBytes);
}

/**
 * Build the system prompt dynamically based on cwd and context.
 *
 * @param toolNames — if provided, the Tools section only lists these tools.
 *   Pass `tools.map(t => t.name)` from the session so the prompt reflects
 *   exactly what the model can call. Defaults to the full built-in set.
 * @param provider — the active LLM provider. Drives the product identity
 *   (`anthropic` → "Claude Code", everything else → "GG Coder").
 * @param environment — extra Environment-section facts (additional workspace
 *   roots, network allowlist). This sits in the cached prefix, so changing it
 *   costs exactly one cache-miss turn.
 * @param deferredToolNames — tools the model can call only after `tool_search`
 *   promotes them. Listed as one-line hints so the capability stays discoverable
 *   while its parameter schema stays out of the request.
 */
export async function buildSystemPrompt(
  cwd: string,
  skills?: Skill[],
  planMode?: boolean,
  approvedPlan?: ApprovedPlanPromptContent | string,
  toolNames?: readonly string[],
  activeLanguages?: Set<LanguageId>,
  provider?: Provider,
  environment?: SystemPromptEnvironment,
  deferredToolNames?: readonly string[],
  /** Byte budgets for skill catalog / project instructions / total ceiling. */
  contextLimits?: ContextLimits,
): Promise<string> {
  const limits = contextLimits ?? CONTEXT_LIMITS;
  const sections: string[] = [
    renderIdentitySection(provider),
    renderTalkSection(toolNames),
    renderWorkSection(),
  ];

  if (planMode) sections.push(renderPlanModeSection());

  const approvedPlanContent =
    typeof approvedPlan === "string"
      ? await fs
          .readFile(approvedPlan, "utf-8")
          .then((content) => ({ content, approvedPlanPath: approvedPlan }))
          .catch(() => undefined)
      : approvedPlan;
  const approvedPlanSection = renderApprovedPlanSection(approvedPlanContent);
  if (approvedPlanSection) sections.push(approvedPlanSection);

  sections.push(renderResearchSection(toolNames, provider), renderCodeQualitySection());

  const toolsSection = renderToolsSection(toolNames, deferredToolNames);
  if (toolsSection) sections.push(toolsSection);

  const delegationSection = renderDelegationSection(toolNames);
  if (delegationSection) sections.push(delegationSection);

  const projectContextSection = renderProjectContextSection(
    await collectProjectContext(cwd, limits),
  );
  if (projectContextSection) sections.push(projectContextSection);

  if (activeLanguages && activeLanguages.size > 0) {
    const stylePacks = renderStylePacksSection(activeLanguages, cwd);
    if (stylePacks) sections.push(stylePacks);

    const verifyCmds = detectVerifyCommands(cwd, activeLanguages);
    const verifySection = renderVerifySection(verifyCmds);
    if (verifySection) sections.push(verifySection);
  }

  if (skills && skills.length > 0) {
    const skillsSection = formatSkillsForPrompt(skills, limits);
    if (skillsSection) sections.push(skillsSection);
  }

  // Hosted-platform CLIs (railway, vercel, gh, ...) the project uses. Stable
  // per host+project, so it sits in the cached body next to Environment.
  const platformClis = renderPlatformClisSection(detectPlatformClis(cwd));
  if (platformClis) sections.push(platformClis);

  sections.push(renderEnvironmentSection(cwd, environment), renderUncachedDateSuffix());

  return enforcePromptCeiling(sections.join("\n\n"), limits.systemPromptCeilingBytes);
}
