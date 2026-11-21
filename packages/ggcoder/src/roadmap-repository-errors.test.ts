import { describe, expect, it } from "vitest";
import { RoadmapGitError } from "./roadmap-git.js";
import {
  classifyRoadmapGitFailure,
  RepositoryUnverifiableError,
  repositoryUnverifiableDiagnostics,
  repositoryUnverifiableNotice,
  type RepositoryUnverifiableReason,
} from "./roadmap-repository-errors.js";

function gitError(
  kind: RoadmapGitError["kind"],
  stderrLine = "",
  exitCode: number | null = 128,
): RoadmapGitError {
  return new RoadmapGitError({
    subcommand: "rev-parse",
    kind,
    exitCode,
    stderrLine,
    elapsedMs: 42,
  });
}

describe("roadmap repository failure classification", () => {
  it.each([
    ["fatal: not a git repository (or any of the parent directories): .git", "not-a-repository"],
    [
      "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      "no-commits",
    ],
    ["fatal: your current branch 'main' does not have any commits yet", "no-commits"],
    ["fatal: bad object HEAD", "git-failed"],
  ] as const)("classifies %s", (stderrLine, reason) => {
    expect(classifyRoadmapGitFailure(gitError("exit", stderrLine), "read HEAD").reason).toBe(
      reason,
    );
  });

  it("classifies a timeout regardless of stderr", () => {
    const error = classifyRoadmapGitFailure(
      gitError("timeout", "fatal: not a git repository"),
      "x",
    );
    expect(error.reason).toBe("git-timeout");
  });

  it("classifies spawn failures and unknown errors as git failures", () => {
    expect(classifyRoadmapGitFailure(gitError("spawn", "ENOENT"), "x").reason).toBe("git-failed");
    expect(classifyRoadmapGitFailure(new Error("boom"), "read HEAD").message).toBe(
      "Git could not read HEAD: boom",
    );
  });

  it("keeps the stable error code and exposes diagnostics", () => {
    const error = classifyRoadmapGitFailure(gitError("timeout", "", null), "read HEAD");
    expect(error).toBeInstanceOf(RepositoryUnverifiableError);
    expect(error.code).toBe("repository-unverifiable");
    expect(repositoryUnverifiableDiagnostics(error)).toEqual({
      reason: "git-timeout",
      subcommand: "rev-parse",
      exitCode: null,
      elapsedMs: 42,
    });
  });

  it("gives every reason its own notice and keeps Git-repository guidance for that reason only", () => {
    const reasons: RepositoryUnverifiableReason[] = [
      "git-timeout",
      "not-a-repository",
      "no-commits",
      "git-failed",
      "workspace-changing",
      "unsafe-workspace",
    ];
    const notices = reasons.map((reason) =>
      repositoryUnverifiableNotice(new RepositoryUnverifiableError(reason)),
    );

    expect(new Set(notices.map((notice) => notice.guidance)).size).toBe(reasons.length);
    for (const [index, notice] of notices.entries()) {
      expect(notice.guidance).toMatch(/retry approval\.$/);
      const mentionsRepository = /Open this project from a Git repository/.test(
        `${notice.message} ${notice.guidance}`,
      );
      expect(mentionsRepository).toBe(reasons[index] === "not-a-repository");
    }
    expect(notices[0]?.message).toMatch(/took too long/);
  });
});
