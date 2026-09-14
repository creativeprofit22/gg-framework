import fs from "node:fs/promises";
import path from "node:path";
import {
  approvedPlanArtifactContent,
  syncApprovedPlanSnapshotForDurability,
  type PersistedPlanReviewCheckpoint,
} from "./app-sidecar-plan-gate.js";

import type {
  AppSidecarPhaseBindingService,
  PhaseBindingSession,
} from "./app-sidecar-phase-binding.js";
import type { RoadmapPhaseLeaseMarkerV1 } from "./phase-context.js";
import type { ProjectNotesRepository, ProjectNotesSnapshot } from "./project-notes-repository.js";

export async function moveApprovedPhaseLeaseToFreshSession(input: {
  binding: AppSidecarPhaseBindingService;
  repository: Pick<ProjectNotesRepository, "load">;
  session: PhaseBindingSession;
  snapshot: ProjectNotesSnapshot;
  phaseId: string;
  checkpoint: Pick<PersistedPlanReviewCheckpoint, "checkpointId" | "generation">;
  previousLease: RoadmapPhaseLeaseMarkerV1;
}): Promise<ProjectNotesSnapshot> {
  const { binding, session, snapshot, phaseId, checkpoint, previousLease } = input;
  const outcome = await binding.lease(
    {
      version: 2,
      action: "takeover",
      phaseId,
      expectedProjectKey: snapshot.projectKey,
      expectedRevision: snapshot.revision,
      planId: checkpoint.checkpointId,
      operationId: `${checkpoint.checkpointId}:fresh-session`,
      lease: { leaseId: previousLease.leaseId, fence: previousLease.fence },
      confirmTakeover: true,
      takeoverReason: "Move approved work to its fresh session",
      predecessorProof: null,
    },
    session,
  );
  if (outcome.status !== "acquired" && outcome.status !== "duplicate") {
    throw new Error(`Phase lease handoff failed: ${outcome.status}`);
  }
  const latest = await input.repository.load(session.getState().cwd);
  if (latest.status !== "ok") throw new Error("Project Notes unavailable after lease handoff.");
  return latest.snapshot;
}

/** Persist the reviewed snapshot with explicit approval metadata.
 * An exact legacy copy is safe to migrate because its bytes are still proven by
 * the durable checkpoint; any other collision remains a hard failure. */
export async function persistApprovedPlanSnapshot(
  cwd: string,
  checkpoint: PersistedPlanReviewCheckpoint,
): Promise<string> {
  const approvedDirectory = path.join(cwd, ".gg", "plans", "approved");
  const approvedPath = path.join(approvedDirectory, `${checkpoint.checkpointId}.md`);
  const approvedContent = approvedPlanArtifactContent(checkpoint.content);
  await fs.mkdir(approvedDirectory, { recursive: true });
  try {
    await fs.writeFile(approvedPath, approvedContent, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(approvedPath, "utf8");
    if (existing === checkpoint.content) {
      await fs.writeFile(approvedPath, approvedContent, "utf8");
    } else if (existing !== approvedContent) {
      throw new Error("Approved plan snapshot path contains different content.", { cause: error });
    }
  }
  const approvedFile = await fs.open(approvedPath, "r");
  try {
    await syncApprovedPlanSnapshotForDurability(() => approvedFile.sync());
  } finally {
    await approvedFile.close();
  }
  return approvedPath;
}
