import { describe, expect, it } from "vitest";
import {
  LOCAL_UPDATE_CONFIRMATION_MESSAGE,
  shouldConfirmLocalUpdate,
} from "./local-update-confirmation";

describe("local update confirmation", () => {
  it("only requires confirmation before a local-patched update starts", () => {
    expect(shouldConfirmLocalUpdate(true, "available")).toBe(true);
    expect(shouldConfirmLocalUpdate(true, "error")).toBe(true);
    expect(shouldConfirmLocalUpdate(true, "installing")).toBe(false);
    expect(shouldConfirmLocalUpdate(false, "available")).toBe(false);
  });

  it("names the canonical merge-preserving flow and safety behavior", () => {
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain(
      "merge upstream/main into custom/local-customizations",
    );
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("without rewriting existing local commits");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).not.toContain("rebase");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).not.toContain("custom/local-customizations-v2");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("backup");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("restore dirty work");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("verify the local fork");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("run checks");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("build a patched installer");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("not install the official binary");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("or push");
  });
});
