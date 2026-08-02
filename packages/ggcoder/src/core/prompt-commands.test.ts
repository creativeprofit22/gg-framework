import { describe, expect, it, vi } from "vitest";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

describe("prompt commands", () => {
  it("no longer defines the /goal command", () => {
    expect(PROMPT_COMMANDS.find((command) => command.name === "goal")).toBeUndefined();
    expect(PROMPT_COMMANDS.find((command) => command.aliases.includes("g"))).toBeUndefined();
  });

  it("hands bullet-proof fixes off to the tasks tool, not a Goal", () => {
    const bulletProof = PROMPT_COMMANDS.find((command) => command.name === "bullet-proof");

    expect(bulletProof?.prompt).toContain("`tasks` tool");
    expect(bulletProof?.prompt).toContain("Press Ctrl+T to open the task list");
    expect(bulletProof?.prompt).not.toContain("Create a Goal");
    expect(bulletProof?.prompt).not.toContain("Press CTRL + G");
  });

  it("adds validated compare findings as deduplicated standalone tasks", () => {
    const compare = PROMPT_COMMANDS.find((command) => command.name === "compare");

    expect(compare?.prompt).toContain("After reporting, automatically add every validated finding");
    expect(compare?.prompt).toContain("`action=list` before adding anything");
    expect(compare?.prompt).toContain("Do not add a semantic duplicate");
    expect(compare?.prompt).toContain("including a duplicate of a done or in-progress task");
    expect(compare?.prompt).toContain("Add exactly one task per finding");
    expect(compare?.prompt).toContain("finding type (MISSING, DIVERGENT, or INCOMPLETE)");
    expect(compare?.prompt).toContain("exact file and line");
    expect(compare?.prompt).toContain("multi-repo kencode-search evidence");
    expect(compare?.prompt).toContain("concrete correction");
    expect(compare?.prompt).toContain("Press Ctrl+T to open the task list");
  });

  it("tells commands that name kencode tools how to unlock deferred MCP", () => {
    // `deferredMcpTools` defaults to true, so `mcp__kencode-search__*` sits in
    // the tool_search catalog until promoted. A command that hard-names it must
    // say how to unlock it, or the call fails on a default install.
    for (const name of ["compare", "expand"]) {
      const cmd = PROMPT_COMMANDS.find((command) => command.name === name);
      expect(cmd?.prompt, name).toContain("mcp__kencode-search__");
      expect(cmd?.prompt, name).toContain("call `tool_search`");
    }
  });

  it("frames bullet-proof as an authorized defensive review with no exploit output", () => {
    const bulletProof = PROMPT_COMMANDS.find((command) => command.name === "bullet-proof");

    expect(bulletProof?.prompt).toContain("authorized defensive security review");
    expect(bulletProof?.prompt).toContain("Never produce working exploit code");
    expect(bulletProof?.prompt).toContain("data-flow level");
    // Subagents never see the command prompt — the handoff must say so.
    expect(bulletProof?.prompt).toContain("Subagents cannot see this prompt.");
    // Skeptic verification is batched to keep fan-out cost bounded.
    expect(bulletProof?.prompt).toContain("batching 3–5 surviving findings per skeptic");
    expect(bulletProof?.prompt).not.toContain("<specific payload>");
  });

  it("points at the app's Tasks button / New Session instead of CLI keybinds when run under gg-app", async () => {
    const previous = process.env.GG_APP_PORT;
    process.env.GG_APP_PORT = "0";
    vi.resetModules();
    try {
      const { PROMPT_COMMANDS: appPromptCommands } = await import("./prompt-commands.js");
      const bulletProof = appPromptCommands.find((command) => command.name === "bullet-proof");
      const compare = appPromptCommands.find((command) => command.name === "compare");
      const init = appPromptCommands.find((command) => command.name === "init");

      expect(bulletProof?.prompt).toContain('Click the "Tasks" button');
      expect(bulletProof?.prompt).not.toContain("Ctrl+T");
      expect(compare?.prompt).toContain('Click the "Tasks" button');
      expect(compare?.prompt).not.toContain("Ctrl+T");
      expect(init?.prompt).toContain("New Session");
      expect(init?.prompt).toContain('click "+ New"');
      expect(init?.prompt).not.toContain("restart ggcoder");
      expect(init?.prompt).not.toContain("/quit");
    } finally {
      if (previous === undefined) delete process.env.GG_APP_PORT;
      else process.env.GG_APP_PORT = previous;
      vi.resetModules();
    }
  });

  it("removes retired prompt-template commands", () => {
    const removedCommandNames = [
      "scan",
      "verify",
      "source",
      "simplify",
      "batch",
      "research",
      "setup",
      "setup-lint",
      `setup-${"tests"}`,
      "setup-update",
    ];
    const removedAliases = ["depcheck", "depsource", "setup-project"];

    for (const name of removedCommandNames) {
      expect(PROMPT_COMMANDS.find((command) => command.name === name)).toBeUndefined();
    }
    for (const alias of removedAliases) {
      expect(PROMPT_COMMANDS.find((command) => command.aliases.includes(alias))).toBeUndefined();
    }
  });

  it("defines /expand as a fresh, repo-validated, feature-first plan-mode command", () => {
    const expand = PROMPT_COMMANDS.find((command) => command.name === "expand");

    expect(expand).toBeDefined();
    expect(expand?.prompt).toContain("Spawn exactly 5 sub-agents in parallel");
    expect(expand?.prompt).toContain("updated within the last 6 months");
    expect(expand?.prompt).toContain("validate it yourself before reporting");
    expect(expand?.prompt).toContain("The table must have exactly 3 columns");
    expect(expand?.prompt).toContain("Do not start implementing until the user chooses");
    expect(expand?.prompt).toContain("A) Build all of these features in plan mode");
    expect(expand?.prompt).toContain("B) Build only the top priority ones in plan mode");
    expect(expand?.prompt).toContain("C) Other");
    expect(expand?.prompt).toContain("call the enter_plan tool");
    expect(expand?.prompt).toContain("call exit_plan with the plan path");
    expect(expand?.prompt).not.toContain("Create a Goal");
    expect(expand?.prompt).not.toContain("planning-only Goal tasks");
  });

  it("keeps /init focused on project-specific context", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    expect(init).toBeDefined();
    expect(init?.prompt).toContain("project-specific context only");
    expect(init?.prompt).toContain("Do NOT add generic agent behavior");
    expect(init?.prompt).toContain("Remove generic guidance");
    expect(init?.prompt).toContain("Never add guidance that requires running checks");
    expect(init?.prompt).toContain("mandatory after-every-edit requirements");
    expect(init?.prompt).toContain("After editing ANY file");
    expect(init?.prompt).toContain(
      "Do not duplicate language style packs, generic verification rules",
    );
    expect(init?.prompt).toContain("Do NOT embed generated symbol maps");
    expect(init?.prompt).toContain("auto-generated project inventories");
    expect(init?.prompt).toContain(
      "context file must remain durable, agent-focused project context",
    );
    expect(init?.prompt).not.toContain("human-authored");
    expect(init?.prompt).not.toContain("one file per component");
    expect(init?.prompt).not.toContain("single responsibility");
    expect(init?.prompt).not.toContain("zero-tolerance code quality checks");
    expect(init?.prompt).not.toContain("run full quality suite after every edit");
  });

  it("states each redundancy rule exactly once so /init reads as one filter", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");
    const count = (needle: string): number => init!.prompt.split(needle).length - 1;

    // The old prompt restated these across the preamble and 3 separate steps.
    // Repetition-as-emphasis is what you write when a rule isn't structurally
    // enforceable; the fence + budget now carry that load instead.
    expect(count("Do NOT add generic agent behavior")).toBe(1);
    expect(count("Do NOT embed generated symbol maps")).toBe(1);
    expect(count("Never add guidance that requires running checks")).toBe(1);
  });

  it("makes /init regeneration replace a fenced block instead of appending", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // /init is re-run over a project's lifetime. Without a marker separating
    // agent-generated from user-written content, "preserve custom sections"
    // preserves everything and the file grows monotonically.
    expect(init?.prompt).toContain("<!-- gg:init:start -->");
    expect(init?.prompt).toContain("<!-- gg:init:end -->");
    expect(init?.prompt).toContain("replace everything between the markers wholesale");
    expect(init?.prompt).toContain("Text outside the fence is user-owned");
  });

  it("makes /init write to the context file the loader actually reads", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // CONTEXT_FILES takes one file per directory, AGENTS.md outranks CLAUDE.md.
    // Writing a fresh CLAUDE.md next to an existing AGENTS.md creates a file
    // that is silently never loaded.
    expect(init?.prompt).toContain("one per directory, first match wins");
    expect(init?.prompt).toContain("AGENTS.override.md`");
    expect(init?.prompt).toContain("already has an `AGENTS.md`, update that file");
  });

  it("budgets /init output in bytes with a stated token cost, not a line cap", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // A line cap is unverifiable by the model and doesn't constrain tables or
    // code fences; the real constraint is PROJECT_CONTEXT_MAX_BYTES (32KB).
    expect(init?.prompt).toContain("cached prefix of every request");
    expect(init?.prompt).toContain("Target 6KB or less");
    expect(init?.prompt).toContain("`wc -c`");
    expect(init?.prompt).not.toContain("under 100 lines");
  });

  it("hunts non-derivable knowledge instead of mapping directories", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // Gotchas/invariants are the only content an agent can't recover by
    // reading the code, so they replace the directory-structure sweep whose
    // output the prompt then forbids embedding anyway.
    expect(init?.prompt).toContain("Gotchas & Invariants Agent");
    expect(init?.prompt).toContain("would a competent agent get this wrong without being told?");
    expect(init?.prompt).not.toContain("Directory Structure Agent");
  });
});
