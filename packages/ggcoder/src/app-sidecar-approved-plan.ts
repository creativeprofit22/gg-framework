import fs from "node:fs/promises";
import path from "node:path";
import {
  approvedPlanArtifactContent,
  syncApprovedPlanSnapshotForDurability,
  type PersistedPlanReviewCheckpoint,
} from "./app-sidecar-plan-gate.js";

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
