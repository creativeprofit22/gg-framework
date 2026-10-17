/**
 * Prompt assembly for the Initialize Git bootstrap, extracted from the modal
 * so the generated instruction is unit-testable without rendering. The prompt
 * embeds the hardened-by-construction CI contract (least privilege, Linux-only,
 * stale-run cancellation, hard timeout) and graceful-degrade rules for
 * protection/AGENTS.md so the agent never stops mid-run to ask.
 */

export type GitVisibility = "private" | "public";

/** What the bootstrap creates beyond the repo itself. All on by default. */
export interface GitBootstrapOptions {
  /** Hardened CI workflow + dependabot.yml, matched to the detected stack. */
  ci: boolean;
  /** Ruleset blocking force-pushes and branch deletion on the default branch. */
  protection: boolean;
  /** AGENTS.md with build/test commands for coding agents. */
  agents: boolean;
}

export const DEFAULT_GIT_BOOTSTRAP_OPTIONS: GitBootstrapOptions = {
  ci: true,
  protection: true,
  agents: true,
};

export interface GitBootstrapInput {
  /** Normalized repo slug (already slugified by the caller). */
  slug: string;
  visibility: GitVisibility;
  options: GitBootstrapOptions;
}

/** Assemble the single complete instruction handed to the agent. */
export function buildGitBootstrapPrompt({ slug, visibility, options }: GitBootstrapInput): string {
  let prompt =
    `Initialize git for this project and publish it to GitHub.\n\n` +
    `Use these settings:\n` +
    `- Repository name: ${slug}\n` +
    `- Visibility: ${visibility}\n\n` +
    `Steps:\n` +
    `1. Run \`git init\` if the project is not already a git repository.\n` +
    `2. Create a sensible .gitignore for this project's stack if one doesn't exist.\n` +
    `3. Stage all files and make an initial commit with a clear message.\n` +
    `4. Create the GitHub repository "${slug}" as ${visibility} using the \`gh\` CLI ` +
    `(\`gh repo create ${slug} --${visibility} --source=. --remote=origin --push\`). ` +
    `If \`gh\` is unavailable or not authenticated, stop and tell the user how to install/auth it.\n` +
    `5. Push the initial commit to the new remote.\n`;

  if (options.ci) {
    prompt +=
      `\n6. Generate CI + dependency updates, matched to this project's stack. ` +
      `Do NOT copy GitHub's starter workflows — generate these:\n` +
      `a. Detect the stack from manifests (\`package.json\` -> Node with the ` +
      `package manager the lockfile indicates; \`pyproject.toml\`/\`requirements.txt\` -> Python; ` +
      `\`go.mod\` -> Go; \`Cargo.toml\` -> Rust; none of these -> treat as static site).\n` +
      `b. Write \`.github/workflows/ci.yml\` with ALL of these rules — every one is required:\n` +
      `   - Triggers: push and pull_request on the default branch.\n` +
      `   - \`permissions:\n     contents: read\` at workflow level (least privilege).\n` +
      `   - One job on \`ubuntu-latest\` ONLY — never macOS (10x billing) or Windows (2x).\n` +
      `   - \`concurrency\` group \`\${{ github.workflow }}-\`\${{ github.head_ref || github.run_id }}\` ` +
      `with \`cancel-in-progress: true\` (cancels stale runs on PR force-pushes).\n` +
      `   - \`timeout-minutes: 15\` on the job.\n` +
      `   - Install + build + test using ONLY commands that exist in the project's ` +
      `manifest/scripts; if there is no test script, run build only and say so.\n` +
      `   - Stack installs: Node -> \`pnpm/action-setup\` if pnpm + \`actions/setup-node\` ` +
      `with \`cache\` set for the package manager; Python -> \`astral-sh/setup-uv\` + \`uv sync\`; ` +
      `Go -> \`actions/setup-go\` (caching is on by default); Rust -> \`Swatinem/rust-cache\` ` +
      `+ minimal stable toolchain.\n` +
      `   - No artifact uploads.\n` +
      `   Use current major versions of the setup actions and note that you verified ` +
      `the version numbers against official docs.\n` +
      `c. Write \`.github/dependabot.yml\` with version updates for \`github-actions\` ` +
      `plus the dependency ecosystem detected in (a).\n` +
      `d. Commit these files and push.\n`;
  }

  let step = options.ci ? 7 : 6;
  if (options.protection) {
    prompt +=
      `\n${step}. Protect the default branch with a ruleset (NOT legacy branch protection):\n` +
      `\`gh api -X POST /repos/{owner}/${slug}/rulesets\` with \`enforcement: active\`, ` +
      `\`conditions.ref_name.include: ["~DEFAULT_BRANCH"]\`, and the rules \`deletion\` and ` +
      `\`non_fast_forward\`. Do NOT require pull requests — the user commits directly. ` +
      `If this fails (needs admin, or the repo is private on a free plan), say so in one ` +
      `line and continue; do not treat it as an error.\n`;
    step += 1;
  }

  if (options.agents) {
    prompt +=
      `\n${step}. ` +
      `Write a brief \`AGENTS.md\` at the repo root for coding agents (Codex, Cursor, ` +
      `Copilot, and others read it as a standard): the build/test/lint commands for this ` +
      `stack, a one-line note that CI lives in \`.github/workflows/ci.yml\` and must stay ` +
      `green, and a rule to never commit with \`--no-verify\`. If a \`CLAUDE.md\` already ` +
      `exists, keep AGENTS.md short and point to it for agent-behavior details. ` +
      `Commit and push it.\n`;
  }

  prompt +=
    `\nDo not ask me any follow-up questions — use the settings above and complete it end to end.` +
    `\nAt the end, report one line per thing you set up (repo, CI, Dependabot, protection, ` +
    `AGENTS.md) and any step you skipped with the reason.`;
  return prompt;
}
