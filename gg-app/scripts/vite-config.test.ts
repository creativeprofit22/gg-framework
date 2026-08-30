import { describe, expect, it, vi } from "vitest";
import { resolveLocalForkBuildEnv } from "../vite.config";

describe("Local Fork Vite build environment", () => {
  const derivedRevision = "a".repeat(40);
  const explicitRevision = "b".repeat(40);

  it("derives the full source revision for explicit local mode", () => {
    const deriveGitSha = vi.fn(() => derivedRevision);

    expect(
      resolveLocalForkBuildEnv({ VITE_GG_LOCAL_PATCHED: "1" }, false, deriveGitSha),
    ).toMatchObject({ localPatched: "1", sourceRevision: derivedRevision });
    expect(deriveGitSha).toHaveBeenCalledOnce();
  });

  it("uses an explicit full revision for an exported build", () => {
    const deriveGitSha = vi.fn(() => null);

    expect(
      resolveLocalForkBuildEnv(
        {
          VITE_GG_LOCAL_PATCHED: "1",
          VITE_GG_SOURCE_ROOT: "/exported/gg-framework",
          VITE_GG_GIT_SHA: explicitRevision,
        },
        false,
        deriveGitSha,
      ),
    ).toMatchObject({
      localPatched: "1",
      sourceRoot: "/exported/gg-framework",
      sourceRevision: explicitRevision,
    });
    expect(deriveGitSha).not.toHaveBeenCalled();
  });

  it.each([undefined, "deadbeef"])("rejects missing or abbreviated revision %s", (revision) => {
    expect(() =>
      resolveLocalForkBuildEnv(
        { VITE_GG_LOCAL_PATCHED: "1", VITE_GG_GIT_SHA: revision },
        false,
        () => null,
      ),
    ).toThrow(/full 40-character source commit SHA/);
  });
});
