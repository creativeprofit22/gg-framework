import { describe, expect, it, vi } from "vitest";
import { getPromptCommand, PROMPT_COMMANDS } from "./prompt-commands.js";

describe("prompt commands", () => {
  it("no longer defines the /goal command", () => {
    expect(PROMPT_COMMANDS.find((command) => command.name === "goal")).toBeUndefined();
    expect(PROMPT_COMMANDS.find((command) => command.aliases.includes("g"))).toBeUndefined();
  });

  it("makes generated /commit commands a lean grouped workflow with one review gate", () => {
    const setupCommit = PROMPT_COMMANDS.find((command) => command.name === "setup-commit");

    expect(setupCommit?.prompt).toContain("Review the full diff");
    expect(setupCommit?.prompt).toContain("Group obvious changes by purpose");
    expect(setupCommit?.prompt).toContain("Keep uncertain or coupled changes together");
    expect(setupCommit?.prompt).toContain("QUALITY COMMANDS] once");
    expect(setupCommit?.prompt).toContain("inspect its staged diff before committing");
    expect(setupCommit?.prompt).toContain("fast review of real bugs");
    expect(setupCommit?.prompt).toContain("findings at least 80");
    expect(setupCommit?.prompt).toContain("one `ask_user` choice");
    expect(setupCommit?.prompt).toContain("rerun affected checks without another review");
    expect(setupCommit?.prompt).toContain("push exactly once after all commits");
    expect(setupCommit?.prompt).not.toContain("current index tree");
  });

  it("strands no audit protocol or dated threat data in a command prompt", () => {
    // /bullet-proof became the bundled `bulletproof` skill (retirement asserted
    // below). Its protocol and incident data must not survive as a copy here,
    // where there is no snapshot date and no confidence marker to age it.
    for (const command of PROMPT_COMMANDS) {
      expect(command.prompt, command.name).not.toContain("CVE-2025-30066");
      expect(command.prompt, command.name).not.toContain("Subagents cannot see this prompt.");
      expect(command.prompt, command.name).not.toContain("surviving findings per skeptic");
    }
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

  it("points /init at the app's New Session instead of CLI keybinds when run under gg-app", async () => {
    const previous = process.env.GG_APP_PORT;
    process.env.GG_APP_PORT = "0";
    vi.resetModules();
    try {
      const { PROMPT_COMMANDS: appPromptCommands } = await import("./prompt-commands.js");
      const compare = appPromptCommands.find((command) => command.name === "compare");
      const init = appPromptCommands.find((command) => command.name === "init");

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
      // Retired into the bundled `bulletproof` skill, which also fires inline
      // during ordinary feature work rather than only when invoked.
      "bullet-proof",
    ];
    const removedAliases = ["depcheck", "depsource", "setup-project", "bp"];

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
    // The choice is offered through `ask_user` (clickable options in the app)
    // and ONLY there: restating the options as text gave the user the same
    // question twice, once clickable and once not. Prose is the fallback for
    // hosts that cannot render the card at all.
    expect(expand?.prompt).toContain("`ask_user` tool");
    expect(expand?.prompt).toContain("Build all of these features in plan mode");
    expect(expand?.prompt).toContain("Build only the top priority ones in plan mode");
    expect(expand?.prompt).toContain("The card is the ONLY ask");
    expect(expand?.prompt).toContain("Only if `ask_user` is unavailable");
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
    expect(init?.prompt).toContain("explicit visual-test overrides");
    expect(init?.prompt).not.toContain("Directory Structure Agent");
  });

  it("keeps /setup-programmatic discovery-only and approval-separated", () => {
    const setup = getPromptCommand("setup-programmatic");
    const scan = getPromptCommand("programmatic");
    const programmaticCommands = PROMPT_COMMANDS.filter((command) =>
      command.name.includes("programmatic"),
    );

    expect(setup).toMatchObject({
      name: "setup-programmatic",
      aliases: [],
      description: "Inspect and propose programmatic setup",
    });
    expect(scan?.input).toEqual({ text: "none", references: "none", attachments: "none" });
    expect(programmaticCommands.map((command) => command.name)).toEqual([
      "setup-programmatic",
      "programmatic",
    ]);
    expect(setup?.prompt).toContain("Load the deferred `programmatic_profile`");
    expect(setup?.prompt).toContain('exactly once with `action: "inspect"`');
    expect(setup?.prompt).toContain("every route, exclusions, drift inputs");
    expect(setup?.prompt).toContain("setup performed no writes");
    expect(setup?.prompt).toContain("Stop for separate user approval");
    expect(setup?.prompt).toContain("exact returned fingerprint and profile");
    expect(setup?.prompt).not.toContain('action: "generate"');
    expect(getPromptCommand("generate-programmatic-profile")).toBeUndefined();
  });

  it("renders /programmatic discovery only when the scan tool is unavailable", () => {
    const deferred = getPromptCommand("programmatic", () => false)!.prompt;
    const eager = getPromptCommand("programmatic", (name) => name === "programmatic_scan")!.prompt;

    expect(deferred).toContain("Load the deferred `programmatic_scan` tool using `tool_search`");
    expect(eager).not.toContain("tool_search");
    for (const prompt of [deferred, eager]) {
      expect(prompt.match(/Call `programmatic_scan`/g)).toHaveLength(1);
      expect(prompt).toContain("exactly once with an empty argument object");
      expect(prompt).toContain("Report only the tool's bounded result");
      expect(prompt).toContain(
        "Never accept or invent paths, scanners, commands, opportunities, lifecycle actions, specialist runs, or shell work.",
      );
    }
  });

  // These assertions lock the built-in prompt contract; generated harness behavior is
  // exercised only by the fixture suites that the prompt requires projects to create.
  it("prompt contract: registers /setup-tauri-package without an alias and resolves it by name", () => {
    const setup = getPromptCommand("setup-tauri-package");

    expect(setup).toBeDefined();
    expect(setup?.name).toBe("setup-tauri-package");
    expect(setup?.aliases).toEqual([]);
    expect(setup?.description).toBe("Set up safe Tauri packaging");
    expect(getPromptCommand("package-tauri")).toBeUndefined();
  });

  it("keeps /setup-tauri-package at the typed-tool boundary", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("Load the deferred `tauri_package` tool using `tool_search`");
    expect(prompt).toContain('`action: "inspect"`');
    expect(prompt).toContain('`action: "setup"`');
    expect(prompt).toContain("exact target ID");
    expect(prompt).toContain("exact `evidence_sha256`");
  });

  it("stops on deterministic discovery ambiguity instead of choosing", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("no target, stop");
    expect(prompt).toContain("multiple targets");
    expect(prompt).toContain("require one explicit target ID");
    expect(prompt).toContain("never choose one");
  });

  it("calibrates only after verified setup and reports no invented outcomes", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("Only after setup succeeds and its verification is successful");
    expect(prompt).toContain('`action: "calibrate"`');
    expect(prompt).toContain("Report only the tool results");
    expect(prompt).toContain("Never invent paths, commands, scripts, hashes");
    expect(prompt).not.toContain("Cargo.toml");
    expect(prompt).not.toContain("spawn");
  });
  it("defines /setup-ci as a dual-mode, stack-agnostic, hardened-by-construction command", () => {
    const setupCi = PROMPT_COMMANDS.find((command) => command.name === "setup-ci");

    expect(setupCi).toBeDefined();
    // Dual mode: generate from scratch OR audit + harden existing workflows.
    expect(setupCi?.prompt).toContain("Mode A: generate");
    expect(setupCi?.prompt).toContain("Mode B: audit + harden");
    // Stack-agnostic: manifests decide, and the detector spans more than Node.
    expect(setupCi?.prompt).toContain("never assume a stack");
    expect(setupCi?.prompt).toContain("Detect the stack (manifests only)");
    expect(setupCi?.prompt).toContain("pyproject.toml");
    expect(setupCi?.prompt).toContain("go.mod");
    expect(setupCi?.prompt).toContain("Cargo.toml");
    // Hardened by construction: every cost/safety rule present.
    expect(setupCi?.prompt).toContain("contents: read");
    expect(setupCi?.prompt).toContain("ubuntu-latest");
    expect(setupCi?.prompt).toContain("10x billing");
    expect(setupCi?.prompt).toContain("cancel-in-progress: true");
    expect(setupCi?.prompt).toContain("timeout-minutes: 15");
    // Publish workflows must never be cancelled mid-flight.
    expect(setupCi?.prompt).toContain("cancelling mid-publish is worse than waiting");
    // Never weakens existing checks; rulesets degrade gracefully; doesn't auto-commit.
    expect(setupCi?.prompt).toContain("NEVER weaken a check to make it pass");
    expect(setupCi?.prompt).toContain("not an error");
    expect(setupCi?.prompt).toContain("Do NOT commit anything");
  });
});
