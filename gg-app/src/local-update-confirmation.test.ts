import { describe, expect, it } from "vitest";
import {
  LOCAL_UPDATE_CONFIRMATION_MESSAGE,
  LOCAL_UPDATE_SUMMARY_DISCLOSURE,
  LOCAL_UPDATE_SUMMARY_LABEL,
  shouldConfirmLocalUpdate,
} from "./local-update-confirmation";

describe("local update confirmation", () => {
  it("only requires confirmation before a local-patched update starts", () => {
    expect(shouldConfirmLocalUpdate(true, "available")).toBe(true);
    expect(shouldConfirmLocalUpdate(true, "error")).toBe(true);
    expect(shouldConfirmLocalUpdate(true, "installing")).toBe(false);
    expect(shouldConfirmLocalUpdate(false, "available")).toBe(false);
  });

  it("discloses optional source excerpts and the connected provider", () => {
    expect(LOCAL_UPDATE_SUMMARY_LABEL).toContain("what changed — and why");
    expect(LOCAL_UPDATE_SUMMARY_LABEL).toContain("connected AI provider");
    expect(LOCAL_UPDATE_SUMMARY_DISCLOSURE).toContain("bounded excerpts");
    expect(LOCAL_UPDATE_SUMMARY_DISCLOSURE).toContain("still works without it");
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
