export function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatWorkspaceTitle(
  cwd: string | undefined,
  gitBranch: string | null | undefined,
  fallback: string,
  gitDirtyFileCount = 0,
  gitHubIssues: number | null = null,
  gitHubPRs: number | null = null,
  additionalRoots: string[] = [],
): string {
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (!directory) return fallback;
  const segments = [directory];
  if (additionalRoots.length > 0)
    segments.push(`+${pluralize(additionalRoots.length, "root", "roots")}`);
  if (gitBranch) segments.push(`⎇ ${gitBranch}`);
  if (gitDirtyFileCount > 0) segments.push(`${gitDirtyFileCount} uncommitted`);
  if (gitHubIssues !== null && gitHubIssues > 0)
    segments.push(pluralize(gitHubIssues, "issue", "issues"));
  if (gitHubPRs !== null && gitHubPRs > 0) segments.push(pluralize(gitHubPRs, "PR", "PRs"));
  return segments.join(" │ ");
}
