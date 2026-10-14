// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HomeUpdateButton } from "./HomeUpdateButton";
import type { UpdateInfo } from "./update";

afterEach(() => {
  cleanup();
});

function renderKey(update: Partial<UpdateInfo>, current: string | null = "0.90.1") {
  const install = vi.fn(async () => {});
  render(
    <HomeUpdateButton
      appUpdate={{ phase: "available", version: "0.91.0", progress: null, install, ...update }}
      current={current}
    />,
  );
  return { install };
}

describe("HomeUpdateButton", () => {
  it("offers the update from your version to the new one, and installs on press", () => {
    const { install } = renderKey({});
    const key = screen.getByRole("button", {
      name: "Update to 0.91.0. Installs and restarts the app.",
    });

    expect(key.textContent).toContain("v0.90.1");
    expect(key.textContent).toContain("v0.91.0");
    fireEvent.click(key);
    expect(install).toHaveBeenCalledOnce();
  });

  it("turns into an XP bar while installing, and can't be pressed twice", () => {
    renderKey({ phase: "installing", progress: 42 });
    const key = screen.getByRole("button", { name: "Installing update, 42%" });

    expect(key.hasAttribute("disabled")).toBe(true);
    expect(key.querySelector<HTMLElement>(".lvl-fill")?.style.width).toBe("42%");
    expect(key.querySelector(".lvl-runner")).not.toBeNull();
  });

  it("reads Updated! and bursts at 100%", () => {
    renderKey({ phase: "installing", progress: 100 });
    const key = screen.getByRole("button", { name: "Update installed. Restarting." });

    expect(key.classList.contains("is-done")).toBe(true);
    expect(key.querySelectorAll(".lvl-burst i").length).toBeGreaterThan(0);
    expect(key.querySelector(".lvl-runner")).toBeNull();
  });

  it("shows nothing without an update", () => {
    renderKey({ phase: "idle" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
