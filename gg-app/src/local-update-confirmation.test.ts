import { describe, expect, it } from "vitest";
import {
  LOCAL_UPDATE_CONFIRMATION_MESSAGE,
  shouldConfirmLocalUpdate,
} from "./local-update-confirmation";

describe("local update confirmation", () => {
  it("only requires confirmation before a local-patched update can be started", () => {
    expect(shouldConfirmLocalUpdate(true, "available")).toBe(true);
    expect(shouldConfirmLocalUpdate(true, "error")).toBe(true);
    expect(shouldConfirmLocalUpdate(true, "installing")).toBe(false);
    expect(shouldConfirmLocalUpdate(false, "available")).toBe(false);
  });

  it("explains the safe source-update workflow", () => {
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("update source");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("reapply your local fixes");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("build a patched installer");
    expect(LOCAL_UPDATE_CONFIRMATION_MESSAGE).toContain("not install the official binary");
  });
});
