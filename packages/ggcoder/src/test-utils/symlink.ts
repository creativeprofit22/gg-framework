import fs from "node:fs";
import fsPromises from "node:fs/promises";

export type TestSymlinkType = "dir" | "file" | "junction";

function needsWindowsJunction(error: unknown): boolean {
  return (
    process.platform === "win32" &&
    error instanceof Error &&
    "code" in error &&
    error.code === "EPERM"
  );
}

/** Uses an unprivileged junction when Windows policy forbids symbolic links. */
export async function createTestSymlink(
  target: string,
  linkPath: string,
  type?: TestSymlinkType,
): Promise<void> {
  try {
    await fsPromises.symlink(target, linkPath, type);
  } catch (error) {
    if (!needsWindowsJunction(error)) throw error;
    await fsPromises.symlink(target, linkPath, "junction");
  }
}

/** Synchronous variant for tests around synchronous filesystem policy. */
export function createTestSymlinkSync(
  target: string,
  linkPath: string,
  type?: TestSymlinkType,
): void {
  try {
    fs.symlinkSync(target, linkPath, type);
  } catch (error) {
    if (!needsWindowsJunction(error)) throw error;
    fs.symlinkSync(target, linkPath, "junction");
  }
}
