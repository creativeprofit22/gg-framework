import { describe, expect, it } from "vitest";
import { LOCAL_TAURI_CONFIG } from "./build-local-hotfix.mjs";

describe("local-patched native identity", () => {
  it("isolates the installer from the production app", () => {
    expect(LOCAL_TAURI_CONFIG).toMatchObject({
      productName: "GG Coder Local Fork",
      mainBinaryName: "gg-coder-local-fork",
      identifier: "com.ggcoder.local-fork",
      bundle: { createUpdaterArtifacts: false },
    });
  });
});
