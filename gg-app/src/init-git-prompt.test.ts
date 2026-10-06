import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_BOOTSTRAP_OPTIONS,
  buildGitBootstrapPrompt,
  type GitBootstrapOptions,
} from "./init-git-prompt";

const OFF: GitBootstrapOptions = { ci: false, protection: false, agents: false };
const ALL = DEFAULT_GIT_BOOTSTRAP_OPTIONS;

describe("buildGitBootstrapPrompt", () => {
  it("always includes the repo-creation core with slug and visibility", () => {
    for (const options of [OFF, ALL]) {
      const prompt = buildGitBootstrapPrompt({ slug: "my-app", visibility: "private", options });
      expect(prompt).toContain("gh repo create my-app --private --source=. --remote=origin --push");
      expect(prompt).toContain("- Repository name: my-app");
      expect(prompt).toContain("- Visibility: private");
      expect(prompt).toContain("Push the initial commit to the new remote.");
      expect(prompt).toContain("Do not ask me any follow-up questions");
    }
  });

  it("emits the hardened CI contract when ci is on", () => {
    const prompt = buildGitBootstrapPrompt({
      slug: "my-app",
      visibility: "public",
      options: { ...OFF, ci: true },
    });
    expect(prompt).toContain(".github/workflows/ci.yml");
    expect(prompt).toContain("contents: read");
    expect(prompt).toContain("ubuntu-latest");
    expect(prompt).toContain("cancel-in-progress: true");
    expect(prompt).toContain("timeout-minutes: 15");
    expect(prompt).toContain(".github/dependabot.yml");
    // Stack detection stays manifest-driven, never Node-assumed.
    expect(prompt).toContain("Detect the stack from manifests");
    expect(prompt).toContain("pyproject.toml");
    expect(prompt).toContain("go.mod");
    expect(prompt).toContain("Cargo.toml");
  });

  it("emits ruleset protection with graceful degrade when protection is on", () => {
    const prompt = buildGitBootstrapPrompt({
      slug: "my-app",
      visibility: "private",
      options: { ...OFF, protection: true },
    });
    expect(prompt).toContain("/repos/{owner}/my-app/rulesets");
    expect(prompt).toContain("~DEFAULT_BRANCH");
    expect(prompt).toContain("non_fast_forward");
    expect(prompt).toContain("do not treat it as an error");
  });

  it("emits the AGENTS.md step when agents is on", () => {
    const prompt = buildGitBootstrapPrompt({
      slug: "my-app",
      visibility: "private",
      options: { ...OFF, agents: true },
    });
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("--no-verify");
  });

  it("omits every optional section when all toggles are off", () => {
    const prompt = buildGitBootstrapPrompt({ slug: "my-app", visibility: "private", options: OFF });
    // Step markers, not bare mentions — the closing report line always names
    // CI/Dependabot/protection/AGENTS.md regardless of toggles.
    expect(prompt).not.toContain("Generate CI + dependency updates");
    expect(prompt).not.toContain("Protect the default branch");
    expect(prompt).not.toContain("Write a brief");
    expect(prompt).not.toContain(".github/workflows");
    expect(prompt).not.toContain("rulesets");
  });

  it("numbers the optional steps by what precedes them", () => {
    // Core is steps 1-5; each enabled option takes the next number in order.
    const ciOnly = buildGitBootstrapPrompt({
      slug: "a",
      visibility: "private",
      options: { ...OFF, ci: true },
    });
    expect(ciOnly).toContain("\n6. Generate CI + dependency updates");

    const ciProtection = buildGitBootstrapPrompt({
      slug: "a",
      visibility: "private",
      options: { ...OFF, ci: true, protection: true },
    });
    expect(ciProtection).toMatch(/\n7\. Protect the default branch/);
    expect(ciProtection).not.toContain("Write a brief");

    const all = buildGitBootstrapPrompt({ slug: "a", visibility: "private", options: ALL });
    expect(all).toMatch(/\n8\. \n?Write a brief `AGENTS\.md`/);

    const protectionOnly = buildGitBootstrapPrompt({
      slug: "a",
      visibility: "private",
      options: { ...OFF, protection: true },
    });
    expect(protectionOnly).toMatch(/\n6\. Protect the default branch/);

    const agentsOnly = buildGitBootstrapPrompt({
      slug: "a",
      visibility: "private",
      options: { ...OFF, agents: true },
    });
    expect(agentsOnly).toMatch(/\n6\. Write a brief `AGENTS\.md`/);
  });
});
