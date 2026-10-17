import type { ProjectNotesSnapshot } from "@kenkaiiii/gg-core/project-notes";
import type { ProjectNotesRepository } from "./project-notes-repository.js";

export async function publishCommittedNotesSnapshot(
  repository: Pick<ProjectNotesRepository, "load">,
  cwd: string,
  committedRevision: number,
  onCommittedSnapshot: ((snapshot: ProjectNotesSnapshot) => void) | undefined,
): Promise<void> {
  if (!onCommittedSnapshot) return;
  const loaded = await repository.load(cwd);
  if (loaded.status !== "ok" || loaded.snapshot.revision < committedRevision) {
    throw new Error("Committed Project Notes snapshot is unavailable.");
  }
  onCommittedSnapshot(loaded.snapshot);
}
