import { describe, expect, it, vi } from "vitest";
import { installUpdateForBuild, type InstallableUpdate } from "./update-policy";

function updateDouble(): InstallableUpdate {
  return { downloadAndInstall: vi.fn().mockResolvedValue(undefined) };
}

describe("installUpdateForBuild", () => {
  it("uses the local-patched source updater and never installs the official binary", async () => {
    const update = updateDouble();
    const startLocalPatchedUpdate = vi.fn().mockResolvedValue(undefined);
    const relaunch = vi.fn().mockResolvedValue(undefined);

    await expect(
      installUpdateForBuild({
        localPatched: true,
        sourceRoot: "C:/ggcoder-projects/gg-framework-fork",
        update,
        startLocalPatchedUpdate,
        relaunch,
      }),
    ).resolves.toBe("local-patched");

    expect(startLocalPatchedUpdate).toHaveBeenCalledExactlyOnceWith(
      "C:/ggcoder-projects/gg-framework-fork",
    );
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("installs and relaunches official builds when an update exists", async () => {
    const update = updateDouble();
    const startLocalPatchedUpdate = vi.fn().mockResolvedValue(undefined);
    const relaunch = vi.fn().mockResolvedValue(undefined);

    await expect(
      installUpdateForBuild({
        localPatched: false,
        sourceRoot: "",
        update,
        startLocalPatchedUpdate,
        relaunch,
      }),
    ).resolves.toBe("official");

    expect(startLocalPatchedUpdate).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("does nothing when official builds have no update", async () => {
    const startLocalPatchedUpdate = vi.fn().mockResolvedValue(undefined);
    const relaunch = vi.fn().mockResolvedValue(undefined);

    await expect(
      installUpdateForBuild({
        localPatched: false,
        sourceRoot: "",
        update: null,
        startLocalPatchedUpdate,
        relaunch,
      }),
    ).resolves.toBe("none");

    expect(startLocalPatchedUpdate).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
