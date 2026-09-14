export type UpdateInstallPath = "local-patched" | "official" | "none";

export interface InstallableUpdate {
  downloadAndInstall: () => Promise<void>;
}

export interface InstallUpdateForBuildOptions {
  localPatched: boolean;
  sourceRoot: string;
  update: InstallableUpdate | null;
  summarizeDecisions?: boolean;
  startLocalPatchedUpdate: (sourceRoot: string, summarizeDecisions?: boolean) => Promise<void>;
  relaunch: () => Promise<void>;
}

export async function installUpdateForBuild({
  localPatched,
  sourceRoot,
  update,
  summarizeDecisions = false,
  startLocalPatchedUpdate,
  relaunch,
}: InstallUpdateForBuildOptions): Promise<UpdateInstallPath> {
  if (localPatched) {
    await startLocalPatchedUpdate(sourceRoot, summarizeDecisions);
    return "local-patched";
  }
  if (!update) return "none";
  await update.downloadAndInstall();
  await relaunch();
  return "official";
}
