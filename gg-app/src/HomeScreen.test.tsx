// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UpdateInfo } from "./update";
import { useAppUpdate } from "./update";
import { HomeScreen } from "./HomeScreen";

const agentMocks = vi.hoisted(() => ({
  waitForReady: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({ configured: true, projectsRoot: "C:/projects" }),
  authStatus: vi.fn().mockResolvedValue([]),
  getServeStatus: vi.fn().mockResolvedValue({ running: false, configured: false }),
  startServe: vi.fn(),
  stopServe: vi.fn(),
  openWhatsNewWindow: vi.fn(),
  getProgress: vi.fn().mockResolvedValue(null),
  setRemoteActive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("1.2.3") }));
vi.mock("./agent", () => agentMocks);
vi.mock("./update", () => ({ useAppUpdate: vi.fn() }));
vi.mock("./AsciiLogo", () => ({ AsciiLogo: () => null }));
vi.mock("./HomeBackdrop", () => ({ HomeBackdrop: () => null }));
vi.mock("./MemeLayer", () => ({ MemeLayer: () => null }));
vi.mock("./SettingsModal", () => ({ SettingsModal: () => null }));
vi.mock("./TelegramSettingsModal", () => ({ TelegramSettingsModal: () => null }));
vi.mock("./McpModal", () => ({ McpModal: () => null }));
vi.mock("./RankBadge", () => ({ RankBadge: () => null }));
vi.mock("./ScorecardModal", () => ({ ScorecardModal: () => null }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

function updateInfo(overrides: Partial<UpdateInfo>): UpdateInfo {
  return {
    update: null,
    version: null,
    phase: "idle",
    progress: null,
    localPatched: true,
    installLabel: "Update (local fixes)",
    installTitle: "Build a patched installer",
    installCommand: "pnpm update:local-fixes",
    statusMessage: null,
    progressLines: [],
    installerPath: null,
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function renderHome(): Promise<void> {
  await act(async () => {
    render(
      <HomeScreen
        onProjects={vi.fn()}
        onChat={vi.fn()}
        onLogin={vi.fn()}
        waitForAgentReady={agentMocks.waitForReady}
        loadProgress={agentMocks.getProgress}
      />,
    );
  });
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  agentMocks.waitForReady.mockResolvedValue(undefined);
  agentMocks.getProgress.mockResolvedValue(null);
  agentMocks.getSettings.mockResolvedValue({ configured: true, projectsRoot: "C:/projects" });
  agentMocks.authStatus.mockResolvedValue([]);
  agentMocks.getServeStatus.mockResolvedValue({ running: false, configured: false });
});

describe("HomeScreen local-patched update outcomes", () => {
  it("keeps the completed outcome visible with the install label fallback", async () => {
    vi.mocked(useAppUpdate).mockReturnValue(
      updateInfo({
        phase: "completed",
        installLabel: "Patched installer built",
        installerPath: "C:/build/installer.exe",
      }),
    );

    await renderHome();

    const outcome = screen.getByRole<HTMLButtonElement>("button", {
      name: "Patched installer built",
    });
    expect(outcome.disabled).toBe(true);
    expect(screen.queryByText("v1.2.3")).toBeNull();
  });

  it("shows the error message and confirms before retrying the protected update", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAppUpdate).mockReturnValue(
      updateInfo({
        phase: "error",
        installLabel: "Local update failed",
        statusMessage: "Merge failed: resolve the source conflict.",
        install,
      }),
    );

    await renderHome();
    fireEvent.click(
      screen.getByRole("button", { name: "Merge failed: resolve the source conflict. — Retry" }),
    );

    expect(install).not.toHaveBeenCalled();
    expect(screen.getByText("Merge and build patched update?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge and build installer" }));
    expect(install).toHaveBeenCalledOnce();
  });

  it("installs an official update directly without local confirmation", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAppUpdate).mockReturnValue(
      updateInfo({
        phase: "available",
        localPatched: false,
        version: "2.0.0",
        installLabel: "Update to 2.0.0",
        install,
      }),
    );

    await renderHome();
    fireEvent.click(screen.getByText("Update to 2.0.0").closest("button")!);

    expect(install).toHaveBeenCalledOnce();
    expect(screen.queryByText("Merge and build patched update?")).toBeNull();
  });
});
