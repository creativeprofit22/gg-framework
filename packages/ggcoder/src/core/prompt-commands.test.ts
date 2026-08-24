import { describe, expect, it, vi } from "vitest";
import { getPromptCommand, PROMPT_COMMANDS } from "./prompt-commands.js";

describe("prompt commands", () => {
  it("no longer defines the /goal command", () => {
    expect(PROMPT_COMMANDS.find((command) => command.name === "goal")).toBeUndefined();
    expect(PROMPT_COMMANDS.find((command) => command.aliases.includes("g"))).toBeUndefined();
  });

  it("makes generated /commit commands a single-approval grouped workflow", () => {
    const setupCommit = PROMPT_COMMANDS.find((command) => command.name === "setup-commit");

    expect(setupCommit?.prompt).toContain("Clicking `/commit` authorizes this entire workflow");
    expect(setupCommit?.prompt).toContain("never enter plan mode");
    expect(setupCommit?.prompt).toContain("Group by coherent intent");
    expect(setupCommit?.prompt).toContain("Keep ambiguity together");
    expect(setupCommit?.prompt).toContain("checked patches");
    expect(setupCommit?.prompt).toContain("Push exactly once after all commits");
    expect(setupCommit?.prompt).not.toContain("Want me to fix this first");
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

  it("prompt contract: requires bounded, corroborated Tauri discovery before writing", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("Perform a bounded inspection");
    expect(prompt).toContain("Tauri v1/v2 configuration");
    expect(prompt).toContain(
      "Cargo crate, Tauri configuration, and frontend Tauri CLI/build entry point",
    );
    expect(prompt).toContain("locally installed Tauri CLI version");
    expect(prompt).toContain("`build --help`");
    expect(prompt).toContain("Stop before any write if no candidate is proven");
    expect(prompt).toContain("multiple candidates remain ambiguous");
    expect(prompt).toContain("mobile-only/unsupported");
    expect(prompt).toContain("Never choose arbitrarily");
  });

  it("prompt contract: limits setup writes and explicitly scopes runtime outputs", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;
    const supportFiles = [
      "scripts/package-tauri.mjs",
      "scripts/package-tauri.test.mjs",
      "scripts/smoke-tauri-package.mjs",
      "scripts/smoke-tauri-package.test.mjs",
      "scripts/package-tauri.config.json",
      ".gg/commands/package-tauri.md",
    ];

    for (const file of supportFiles) expect(prompt, file).toContain(`\`${file}\``);
    expect(prompt).toContain("only these six support files");
    expect(prompt).toContain("Do not install dependencies");
    expect(prompt).toContain("edit package manifests or their scripts");
    expect(prompt).toContain("existing audited build entry point");
    expect(prompt).toContain("must never create or change signing configuration");
    expect(prompt).toContain(
      "Runtime calibration, packaging, and verification may additionally write",
    );
    expect(prompt).toContain("declared in the config");
    expect(prompt).toContain("never modify source or configuration files");
    expect(prompt).toContain("node scripts/package-tauri.mjs --target <id>");
    expect(prompt).toContain("never bypass a failed build, gate, manifest, or smoke result");
  });

  it("prompt contract: forbids plan mode and every .gg/plans output", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("Do not enter or use plan mode");
    expect(prompt).toContain("call `enter_plan` or `exit_plan`");
    expect(prompt).toContain("create or update any file below `.gg/plans/`");
    expect(prompt).toContain("A plan file is outside the six-file boundary");
  });

  it("prompt contract: protects manual edits with shared evidence and content digests", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("Generated by GG Coder /setup-tauri-package tauri-package v1");
    expect(prompt).toContain("shared evidence SHA-256");
    expect(prompt).toContain("content SHA-256");
    expect(prompt).toContain("removes only the content-digest field before hashing");
    expect(prompt).toContain("validate them as one transaction");
    expect(prompt).toContain("modified generated body");
    expect(prompt).toContain("partial foreign set");
    expect(prompt).toContain("preserve all six destinations byte-for-byte");
    expect(prompt).toContain("prevent partial writes");
  });

  it("prompt contract: requires deterministic normalized rendering and changed-evidence rerenders", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("repository-relative path using `/` separators");
    expect(prompt).toContain("Reject absolute paths, traversal");
    expect(prompt).toContain("executable-plus-argument arrays, never shell strings");
    expect(prompt).toContain("stable key ordering");
    expect(prompt).toContain("LF endings");
    expect(prompt).toContain("no timestamps");
    expect(prompt).toContain("Changed evidence triggers one complete rerender");
    expect(prompt).toContain("changed generated bytes trigger a conflict");
  });

  it("prompt contract: returns before rendering when owned evidence is unchanged", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("compare their single shared evidence digest");
    expect(prompt).toContain("with the freshly audited evidence before rendering");
    expect(prompt).toContain("return successfully immediately");
    expect(prompt).toContain("do not render, regenerate, or write any support file");
    expect(prompt).toContain("This early no-op is the only same-evidence path");
    expect(prompt).toContain("Only when freshly audited evidence differs");
    expect(prompt).toContain("render and replace all six transactionally");
  });

  it("prompt contract: requires owned shell-free builds and fresh target-scoped output", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("accepting only help");
    expect(prompt).toContain("`--calibrate --target <id>`");
    expect(prompt).toContain("`--verify --target <id>`");
    expect(prompt).toContain("`execFile` or `spawn` with `shell: false`");
    expect(prompt).toContain("Clear only the exact marker-owned selected target bundle directory");
    expect(prompt).toContain("Never clean the project's ordinary Cargo target");
    expect(prompt).toContain("Record run start before spawning");
    expect(prompt).toContain("every artifact must be newly discovered there");
    expect(prompt).toContain("Reject stale pre-existing artifacts");
    expect(prompt).toContain("output found outside the expected target root");
  });

  it("prompt contract: locks baseline gates and pruning to calibrated evidence", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("pre-prune baseline inventory");
    expect(prompt).toContain("target-specific literal prune entries");
    expect(prompt).toContain("each carrying target, local evidence, and reason");
    expect(prompt).toContain("Pruning is staging-only");
    expect(prompt).toContain("required-file collisions");
    expect(prompt).toContain("An empty prune list is correct");
    expect(prompt).toContain("Never infer that debug symbols");
    expect(prompt).toContain("required-file existence, type, role");
    expect(prompt).toContain("exact/min/max cardinality");
    expect(prompt).toContain("total bytes, per-role/artifact bytes, regular-file count");
    expect(prompt).toContain("allowed absolute plus percentage growth");
    expect(prompt).toContain("An uncalibrated target fails a normal package run closed");
  });

  it("prompt contract: calibration exits nonzero until smoke and persisted state validate", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain("`--calibrate` must fail closed and exit nonzero unless");
    expect(prompt).toContain("packaged smoke satisfies its configured readiness criterion");
    expect(prompt).toContain("persisted through the complete six-file ownership transaction");
    expect(prompt).toContain("persisted state is reloaded and validates the target as calibrated");
    expect(prompt).toContain("A successful build or discovered artifact alone");
    expect(prompt).toContain("leave the target explicitly uncalibrated and exit nonzero");
  });

  it("prompt contract: requires manifests, packaged smoke, and rollback-safe promotion", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain(
      "lexically sorted SHA-256 manifest covering every regular distributable file",
    );
    expect(prompt).toContain("Validate contained symlinks separately");
    expect(prompt).toContain("verify every hash again to detect smoke mutation");
    expect(prompt).toContain("rollback-safe two-rename swap");
    expect(prompt).toContain("marker-owned previous final output");
    expect(prompt).toContain("restore the backup if the second rename fails");
    expect(prompt).toContain("Do not claim this directory replacement is atomic across platforms");
    expect(prompt).toContain("directly runnable artifact from the candidate package");
    expect(prompt).toContain("never a source-tree binary");
    expect(prompt).toContain("MSI/NSIS installers, DMGs, DEB/RPM packages");
    expect(prompt).toContain("isolated temporary HOME/user/config/cache directories");
    expect(prompt).toContain("terminate only that child tree");
    expect(prompt).toContain("any package mutation fails");
  });

  it("prompt contract: orders terminal real-project verification after promotion", () => {
    const prompt = getPromptCommand("setup-tauri-package")!.prompt;

    expect(prompt).toContain(
      "`node:test`, Node standard-library modules, and temporary directories",
    );
    expect(prompt).toContain(
      "fake builder producing fresh artifacts, stale artifacts, failed exits",
    );
    expect(prompt).toContain("healthy bounded survival, explicit readiness, early crash, timeout");
    expect(prompt).toContain("source guards that fail");
    expect(prompt).toContain("broad or unscoped recursive deletion");
    expect(prompt).toContain("gate/manifest/smoke bypass flags");
    expect(prompt).toContain(
      "node --test scripts/package-tauri.test.mjs scripts/smoke-tauri-package.test.mjs",
    );
    expect(prompt).toContain("run one real `/package-tauri`-equivalent invocation");
    expect(prompt).toContain("Only after promotion succeeds");
    expect(prompt).toContain("--verify --target <id>");
    expect(prompt).not.toContain("run inspect/verification and calibration");
    expect(prompt).toContain("prove all six bytes are identical");
    expect(prompt).toContain("`git status --short` before and after that second render");
    expect(prompt).toContain("Never report a successful package");
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
