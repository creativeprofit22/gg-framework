import { RoadmapGitError } from "./roadmap-git.js";

export type RepositoryUnverifiableReason =
  | "git-timeout"
  | "not-a-repository"
  | "no-commits"
  | "git-failed"
  | "workspace-changing"
  | "unsafe-workspace";

const DEFAULT_MESSAGES: Record<RepositoryUnverifiableReason, string> = {
  "git-timeout": "Git took too long to answer.",
  "not-a-repository": "The Git repository could not be verified.",
  "no-commits": "This Git repository has no commits yet.",
  "git-failed": "Git could not read the repository.",
  "workspace-changing": "The workspace changed while it was being captured.",
  "unsafe-workspace": "Git returned an unsafe workspace entry.",
};

export class RepositoryUnverifiableError extends Error {
  readonly code = "repository-unverifiable";
  readonly reason: RepositoryUnverifiableReason;

  constructor(
    reason: RepositoryUnverifiableReason,
    options: { message?: string; cause?: unknown } = {},
  ) {
    super(
      options.message ?? DEFAULT_MESSAGES[reason],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RepositoryUnverifiableError";
    this.reason = reason;
  }
}

const NOT_A_REPOSITORY = /not a git repository/i;
const NO_COMMITS =
  /unknown revision|ambiguous argument 'HEAD'|bad revision 'HEAD'|does not have any commits/i;

/** `step` completes "Git could not …", e.g. "read HEAD". */
export function classifyRoadmapGitFailure(
  error: unknown,
  step: string,
): RepositoryUnverifiableError {
  if (error instanceof RepositoryUnverifiableError) return error;
  if (!(error instanceof RoadmapGitError)) {
    const detail = error instanceof Error ? error.message : String(error);
    return new RepositoryUnverifiableError("git-failed", {
      message: `Git could not ${step}: ${detail}`,
      cause: error,
    });
  }
  if (error.kind === "timeout") {
    return new RepositoryUnverifiableError("git-timeout", { cause: error });
  }
  if (error.kind === "spawn") {
    return new RepositoryUnverifiableError("git-failed", {
      message: `Git could not start: ${error.stderrLine || "unknown error"}`,
      cause: error,
    });
  }
  if (NOT_A_REPOSITORY.test(error.stderrLine)) {
    return new RepositoryUnverifiableError("not-a-repository", { cause: error });
  }
  if (NO_COMMITS.test(error.stderrLine)) {
    return new RepositoryUnverifiableError("no-commits", { cause: error });
  }
  const detail = error.stderrLine || `exit code ${error.exitCode ?? "unknown"}`;
  return new RepositoryUnverifiableError("git-failed", {
    message: `Git could not ${step}: ${detail}`,
    cause: error,
  });
}

export interface RepositoryUnverifiableNotice {
  message: string;
  guidance: string;
}

export function repositoryUnverifiableNotice(
  error: RepositoryUnverifiableError,
  retry = "retry approval",
): RepositoryUnverifiableNotice {
  switch (error.reason) {
    case "git-timeout":
      return {
        message: "Git took too long to answer, usually because the disk is busy.",
        guidance: `Wait a moment, then ${retry}.`,
      };
    case "not-a-repository":
      return {
        message: error.message,
        guidance: `Open this project from a Git repository, then ${retry}.`,
      };
    case "no-commits":
      return { message: error.message, guidance: `Make a first commit, then ${retry}.` };
    case "workspace-changing":
      return {
        message: "Files kept changing while the workspace was being captured.",
        guidance: `Stop running builds or watchers, then ${retry}.`,
      };
    case "unsafe-workspace":
      return {
        message: error.message,
        guidance: `Remove or rename that workspace entry, then ${retry}.`,
      };
    case "git-failed":
      return { message: error.message, guidance: `Fix the Git problem above, then ${retry}.` };
  }
}

export function repositoryUnverifiableDiagnostics(error: RepositoryUnverifiableError): {
  reason: RepositoryUnverifiableReason;
  subcommand: string | null;
  exitCode: number | null;
  elapsedMs: number | null;
} {
  const cause = error.cause instanceof RoadmapGitError ? error.cause : null;
  return {
    reason: error.reason,
    subcommand: cause?.subcommand ?? null,
    exitCode: cause?.exitCode ?? null,
    elapsedMs: cause?.elapsedMs ?? null,
  };
}
