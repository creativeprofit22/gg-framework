// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type * as ReactDomClient from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  setTheme: vi.fn(async () => {}),
  invoke: vi.fn(async () => {}),
  label: "whatsnew",
  close: vi.fn(async () => {}),
}));
vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: mocks.render }) } }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ close: mocks.close, listen: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ attachConsole: async () => {}, error: vi.fn() }));
vi.mock("./App", () => ({ default: () => null }));
vi.mock("./ZoomController", () => ({ ZoomController: () => null }));
vi.mock("./WhatsNewModal", () => ({ WhatsNewModal: () => null }));
vi.mock("./Confetti", () => ({ Confetti: () => null }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./agent", () => ({ getVerifiedDecisions: async () => [] }));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  document.documentElement.classList.remove("whatsnew-root");
  localStorage.clear();
  vi.restoreAllMocks();
});

it("renders queued startup and later native failures through the standalone entry's real toast bus", async () => {
  window.history.replaceState(null, "", "/?whatsnew=1");
  localStorage.setItem("gg-app:appearance:v1", JSON.stringify({ theme: "light" }));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.setTheme.mockRejectedValueOnce(new Error("permission denied"));
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);

  // Execute real startup, but delay React mounting until its native rejection has
  // reached the real bus. This deterministically exercises the pre-subscriber race.
  await import("./main");
  await act(async () => {});
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Native appearance synchronization failed"));
  expect(screen.queryByRole("status")).toBeNull();
  const client = await vi.importActual<typeof ReactDomClient>("react-dom/client");
  root = client.createRoot(container);
  await act(async () => root!.render(mocks.render.mock.calls[0][0] as ReactNode));
  const message = "Window appearance could not be updated. The selected theme still applies to content.";
  expect((await screen.findByRole("status")).textContent).toBe(message);
  expect(container.querySelectorAll(".toaster")).toHaveLength(1);
  await screen.findByRole("button", { name: "Got it" });

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(screen.queryByRole("status")).toBeNull();

  mocks.invoke.mockRejectedValueOnce(new Error("permission denied"));
  await act(async () => {
    localStorage.setItem("gg-app:appearance:v1", JSON.stringify({ theme: "dark" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "gg-app:appearance:v1" }));
  });
  expect((await screen.findByRole("status")).textContent).toBe(message);
  expect(mocks.invoke).toHaveBeenLastCalledWith("plugin:window|set_background_color", {
    label: "whatsnew",
    value: "#0f1115",
  });
  expect(document.documentElement.dataset.appearanceTheme).toBe("dark");
  expect(consoleError).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(mocks.close).toHaveBeenCalledTimes(3);
});
