// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";
import type { UpdatePhase } from "./update";

afterEach(cleanup);

describe("UpdateBanner (Local Fork)", () => {
  it("never renders an update prompt and never installs, in any phase", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const phases: UpdatePhase[] = [
      "idle",
      "checking",
      "available",
      "installing",
      "completed",
      "error",
    ];
    for (const phase of phases) {
      const install = vi.fn(async () => {});
      const { container } = render(
        <UpdateBanner appUpdate={{ phase, version: "9.9.9", progress: 42, install }} />,
      );
      expect(container.innerHTML).toBe("");
      expect(install).not.toHaveBeenCalled();
      cleanup();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
