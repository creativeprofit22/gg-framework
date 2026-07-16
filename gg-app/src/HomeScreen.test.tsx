// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeScreen } from "./HomeScreen";

const mocks = vi.hoisted(() => ({
  authStatus: vi.fn(() => Promise.resolve([])),
  getProgress: vi.fn(),
  getSettings: vi.fn(() => Promise.resolve(null)),
  getServeStatus: vi.fn(),
  toast: vi.fn(),
  waitForReady: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("0.21.1")) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({
  authStatus: mocks.authStatus,
  getProgress: mocks.getProgress,
  getServeStatus: mocks.getServeStatus,
  getSettings: mocks.getSettings,
  openWhatsNewWindow: vi.fn(),
  startServe: vi.fn(),
  stopServe: vi.fn(),
  waitForReady: mocks.waitForReady,
}));
vi.mock("./toast", () => ({ toast: mocks.toast }));
vi.mock("./update", () => ({
  useAppUpdate: () => ({
    update: null,
    version: null,
    phase: "idle",
    localPatched: false,
    installLabel: "Update",
    installTitle: "Update",
    installCommand: null,
    statusMessage: null,
    progressLines: [],
    installerPath: null,
    install: vi.fn(),
  }),
}));
vi.mock("./AsciiLogo", () => ({ AsciiLogo: () => <div>GG Coder</div> }));
vi.mock("./HomeBackdrop", () => ({ HomeBackdrop: () => null }));
vi.mock("./MemeLayer", () => ({ MemeLayer: () => null }));
vi.mock("./SettingsModal", () => ({ SettingsModal: () => null }));
vi.mock("./TelegramSettingsModal", () => ({ TelegramSettingsModal: () => null }));
vi.mock("./McpModal", () => ({ McpModal: () => null }));
vi.mock("./ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("./RankBadge", () => ({ RankBadge: () => null }));
vi.mock("./ScorecardModal", () => ({ ScorecardModal: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeScreen", () => {
  it("reports pane-scoped startup failure while loading progress", async () => {
    const waitForAgentReady = vi.fn(() => Promise.reject(new Error("primary pane unavailable")));
    const loadProgress = vi.fn();
    render(
      <HomeScreen
        onProjects={vi.fn()}
        onChat={vi.fn()}
        onLogin={vi.fn()}
        waitForAgentReady={waitForAgentReady}
        loadProgress={loadProgress}
      />,
    );

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(
        "Agent failed to start: primary pane unavailable",
        "error",
      );
    });
    expect(waitForAgentReady).toHaveBeenCalledOnce();
    expect(loadProgress).not.toHaveBeenCalled();
  });
});
