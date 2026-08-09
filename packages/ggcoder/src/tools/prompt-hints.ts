/**
 * One-line prompt hints for each tool, shown in the system prompt's Tools
 * section. Full parameter docs live on each tool's JSON schema description
 * (sent separately via the tool definition), so these hints stay short.
 *
 * Hints exist ONLY for tools whose correct usage is NOT obvious from their
 * schema description alone. The core file/nav/exec tools (read/write/edit/
 * bash/find/grep/ls) deliberately have NO hint: an ablation (experiments/
 * prompt-bench, Opus n=12) showed dropping their hints did not change tool
 * selection — the schema description already carries when/how to use them.
 * Cross-tool preferences for those tools live in TOOL_STEERING instead.
 */
export const TOOL_PROMPT_HINTS: Record<string, string> = {
  code_nav:
    "Language-server navigation: `definition`, `references`, `symbols` (file outline), `hover` " +
    "(type/signature). Exact and cross-file, unlike text search.",
  code_search:
    "Find the most relevant functions/classes/types for a query via AST chunking + BM25 " +
    "ranking. Returns whole ranked symbol chunks with `file:line → symbol` headers — far fewer " +
    "tokens than reading whole files. TS/JS, Python, Go, Rust, Java, C#.",
  source_path:
    "Resolve installed package/repo source via opensrc. Inspect the returned path with read/grep/find/ls before assuming a dependency API.",
  web_search:
    "Search the web. Use before web_fetch to find pages; supports include/exclude_domains and a time_range recency filter.",
  web_fetch:
    "Fetch page content as Markdown (or text/html). Pass `urls` to fetch many at once; reads PDFs, follows safe redirects, and prefers a site's /llms.txt for docs.",
  task_output: "Read new output from a background process by id.",
  task_stop: "Stop a background process by id.",
  screenshot:
    "Capture a headless-browser PNG of a URL or dev server to visually verify rendered UI; supports waits, click/type actions and viewport size.",
  send_message: "Queue steering into a running child agent without starting another turn.",
  followup_task: "Start another turn in an idle child agent, preserving its context.",
  wait_agent: "Block until named child agents finish and return their output snapshots.",
  list_agents: "List child agent IDs, states, turns and token totals.",
  interrupt_agent: "Interrupt a child agent's current turn, keeping its context for a follow-up.",
  tasks:
    "Manage the project task list. Never proactively — only on explicit request, or at a slash-command's task-handoff step.",
  enter_plan:
    "Enter read-only plan mode for complex/risky tasks before implementation; draft a plan under .gg/plans/.",
  exit_plan: "Submit a .gg/plans/ markdown plan for user approval and leave plan mode.",
  subagent: "Delegate focused, isolated subtasks (research, parallel exploration).",
  skill: "Invoke a named skill for specialized instructions.",
  tool_search:
    "Load any tool listed as available on demand, plus the extended catalog of " +
    "integrations (MCP servers) — e.g. 'take a screenshot', 'search public GitHub code'. " +
    "Matches become callable on your next step. Check the catalog BEFORE concluding you " +
    "lack a capability.",
  generate_image:
    "Generate or edit images via OpenAI's gpt-image-2. Only when the user explicitly asks — never proactively. Pass `image` to edit an existing file.",
  "mcp__kencode-search__referenceSources":
    "Get curated, categorized reference repos for examples, inspiration, architecture, UI, agents, SaaS, workflows, and domain patterns. Repo-only starting points; fetch docs/source, then verify code with searchCode.",
  "mcp__kencode-search__discoverRepos":
    "Search GitHub repos live by keyword/language/topic/stars/recency. Use for current/top repos or long-tail discovery; returns metadata, not snippets. Follow with docs/source and searchCode.",
  "mcp__kencode-search__searchCode":
    "Verify public GitHub code by literal text or RE2 regex; NOT semantic. Put code/import/API tokens in `query`; `path` is a literal file-path substring, not a concept. Start broad/peek, then narrow by repo/path. RE2 multi-line needs `(?s)`.",
};

/**
 * Cross-tool selection guidance that no single tool's own schema description
 * can state (it's relational). Each clause only renders when its tools are
 * actually active, so the line never references an unavailable tool. Proven
 * equivalent to the full per-tool hint list in the prompt-bench ablation
 * while costing ~95% fewer words.
 */
export const TOOL_STEERING_CLAUSES: ReadonlyArray<{
  needs: readonly string[];
  text: string;
}> = [
  {
    needs: ["edit", "write"],
    text: "Prefer `edit` over `write` for changes to existing files.",
  },
  {
    needs: ["bash", "find", "grep"],
    text: "Use `find`/`grep` rather than `bash` to locate files and search content.",
  },
  {
    needs: ["code_search", "grep", "read"],
    text: "Prefer `code_search` for “where/how is X implemented”; use `grep` for exact strings or unindexed file types.",
  },
  {
    needs: ["code_nav", "grep"],
    text: "For “who calls this” / “where is this defined”, use `code_nav` — it resolves symbols exactly, across files; `grep` only matches text and misses renames, re-exports and shadowing.",
  },
  {
    needs: ["read", "grep", "ls", "find"],
    text: "Batch independent read-only calls (read, grep, ls, find) into one turn — they run in parallel, so it's faster than one per turn; only serialize a call that depends on a previous result.",
  },
];

/** Build the steering line from whichever clauses apply to the active tools. */
export function buildToolSteering(activeTools: readonly string[]): string {
  const active = new Set(activeTools);
  return TOOL_STEERING_CLAUSES.filter((c) => c.needs.every((n) => active.has(n)))
    .map((c) => c.text)
    .join(" ");
}

/**
 * Every tool name `createTools()` can register, including the conditional ones
 * (web_search on non-Anthropic providers, generate_image with OpenAI auth,
 * plan tools, the subagent cluster) and `tool_search`, which MCP deferred
 * loading adds. Used to validate an agent definition's `tools:` frontmatter —
 * an unknown name is silently dropped by the session allow-list, so a typo
 * would otherwise cost the agent a capability with no signal at all.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "bash",
  "code_nav",
  "code_search",
  "edit",
  "enter_plan",
  "exit_plan",
  "find",
  "followup_task",
  "generate_image",
  "grep",
  "interrupt_agent",
  "list_agents",
  "ls",
  "read",
  "screenshot",
  "send_message",
  "skill",
  "source_path",
  "spawn_agent",
  "subagent",
  "task_output",
  "task_send",
  "task_stop",
  "tasks",
  "tool_search",
  "wait_agent",
  "web_fetch",
  "web_search",
  "write",
];

/** Tools always rendered when no explicit tool list is provided. */
export const DEFAULT_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "code_nav",
  "code_search",
  "ls",
  "source_path",
  "web_fetch",
  "task_output",
  "task_stop",
  "enter_plan",
  "exit_plan",
  "subagent",
  "skill",
  "generate_image",
  "mcp__kencode-search__referenceSources",
  "mcp__kencode-search__discoverRepos",
  "mcp__kencode-search__searchCode",
];
