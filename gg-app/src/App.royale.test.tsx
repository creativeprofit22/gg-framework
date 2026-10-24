// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
// Fork: daemon-level calls (GG Royale's included) first wait for the primary
// pane's readiness, which this IPC mock never reports. Skip only that wait; the
// Royale commands are still answered through the mocked IPC below.
vi.mock("./agent", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentModule>();
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    ...actual,
    royaleStatus: async () => invoke<{ linked: boolean; serverUrl: string }>("agent_royale_status"),
    openRoyale: async () => invoke<string>("agent_royale_open"),
    royaleSummary: async () => null,
  };
});
// Fork: App is the multi-pane WorkspaceShell; Home lives in each AgentPane,
// so the pane is rendered directly (as App renders it in a single-pane window).
const { AgentPane: App } = await import("./AgentPane");

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("GG Royale from Home", () => {
  it("opens over Home (Home stays underneath for the fade in), and Back goes straight home", async () => {
    mockWindows("main");
    mockIPC((command) => {
      switch (command) {
        case "window_restore_target":
          return null; // no project: the window starts on Home
        case "sidecar_port":
          return 12345;
        case "agent_royale_status":
          return { linked: true, serverUrl: "https://royale.test" };
        case "agent_royale_open":
          return "https://royale.test/#code=abc";
        case "plugin:log|log":
          return null;
        default:
          return new Promise(() => {});
      }
    });
    // This computer already agreed to the current link box.
    localStorage.setItem("gg-royale-consent", "999");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Royale" }));

    const frame = await screen.findByLabelText("GG Royale");
    // The game sits in the full-window overlay, with Home still mounted under it.
    expect(frame.closest(".royale-overlay")).not.toBeNull();
    expect(document.querySelector(".home")).not.toBeNull();

    // Back returns to Home straight away, like every other screen.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.querySelector(".royale-overlay")).toBeNull());
    expect(document.querySelector(".home")).not.toBeNull();
  });
});
