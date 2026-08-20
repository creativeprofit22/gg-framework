import { describe, expect, it, vi } from "vitest";
import { resolveLocalForkBuildEnv } from "../vite.config";

describe("Local Fork Vite build environment", () => {
  it("derives the SHA for explicit local mode when Git metadata is available", () => {
    const deriveGitSha = vi.fn(() => "abc1234");

    expect(
      resolveLocalForkBuildEnv({ VITE_GG_LOCAL_PATCHED: "1" }, false, deriveGitSha),
    ).toMatchObject({ localPatched: "1", gitSha: "abc1234" });
    expect(deriveGitSha).toHaveBeenCalledOnce();
  });

  it("uses an explicit SHA for an exported build without Git metadata", () => {
    const deriveGitSha = vi.fn(() => null);

    expect(
      resolveLocalForkBuildEnv(
        {
          VITE_GG_LOCAL_PATCHED: "1",
          VITE_GG_SOURCE_ROOT: "/exported/gg-framework",
          VITE_GG_GIT_SHA: "deadbeef",
        },
        false,
        deriveGitSha,
      ),
    ).toMatchObject({
      localPatched: "1",
      sourceRoot: "/exported/gg-framework",
      gitSha: "deadbeef",
    });
    expect(deriveGitSha).not.toHaveBeenCalled();
  });

  it("rejects an explicit local build without Git metadata or a SHA", () => {
    expect(() =>
      resolveLocalForkBuildEnv({ VITE_GG_LOCAL_PATCHED: "1" }, false, () => null),
    ).toThrow(/VITE_GG_GIT_SHA is required.*Git metadata is unavailable/);
  });
});
