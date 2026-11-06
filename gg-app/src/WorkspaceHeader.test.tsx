// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// WorkspaceHeader imports agent.ts (openProjectPath), which reads the current
// webview window at module load — stub it for jsdom.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
}));

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { WorkspaceHeader } from "./WorkspaceHeader";
import { formatWorkspaceTitle } from "./workspace-title";
import { PaneIdProvider } from "./pane-context";

afterEach(cleanup);

describe("WorkspaceHeader", () => {
  // Split panes: the folder button opens the folder of the pane it sits in.
  it.each(["primary", "secondary"])("opens the originating %s pane folder", (paneId) => {
    invoke.mockClear();
    render(
      <PaneIdProvider value={paneId}>
        <WorkspaceHeader workspaceMode="code" cwd="/work/project" />
      </PaneIdProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "project. Open the folder" }));
    expect(invoke).toHaveBeenCalledWith("open_project_path", { paneId, path: "/work/project" });
  });

  // The title shows only the folder name; native cross-pane smokes prove each
  // pane's project against the full path the header carries.
  it("carries the pane's full project path", () => {
    const { container } = render(<WorkspaceHeader workspaceMode="code" cwd="/work/project" />);
    expect(container.querySelector<HTMLElement>(".chat-head")?.dataset.cwd).toBe("/work/project");
  });

  it("is one row: back, the title, and the trailing actions", () => {
    const { container } = render(
      <WorkspaceHeader
        workspaceMode="chat"
        subtitle="General"
        leading={<button>Back</button>}
        trailing={<button>Commit</button>}
      />,
    );

    expect(screen.getByText("GG Chat")).toBeDefined();
    expect(screen.getByText("General")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDefined();
    expect(container.querySelectorAll(".chat-head > *")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /nav buttons/ })).toBeNull();
  });

  it("formats clean, dirty, and pre-commit project context for the tooltip", () => {
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder")).toBe("app · main");
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder", 3)).toBe(
      "app · main · 3 uncommitted",
    );
    expect(formatWorkspaceTitle("/work/app", null, "GG Coder", 1)).toBe("app · 1 uncommitted");
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder", 0, 4, 1)).toBe(
      "app · main · 4 issues · 1 PR",
    );
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder", 0, 3, 0)).toBe(
      "app · main · 3 issues",
    );
    expect(
      formatWorkspaceTitle("/work/app", "main", "GG Coder", 0, null, null, ["/work/sdk"]),
    ).toBe("app · +1 root · main");
  });

  it("names the window after its folder, which opens on click, with the full context on hover", () => {
    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd={"C:\\work\\gg-coder"}
        gitBranch="feature/titlebar"
        gitDirtyFileCount={3}
      />,
    );

    const folder = screen.getByRole("button", { name: "gg-coder. Open the folder" });
    // One tooltip only: the title's, never a second on the folder button.
    expect(folder.getAttribute("title")).toBeNull();
    expect(screen.getByTitle("gg-coder · feature/titlebar · 3 uncommitted")).toBeDefined();
    expect(screen.queryByText("GG Coder")).toBeNull();
  });

  it("titles a Goal window with the goal's name", () => {
    render(<WorkspaceHeader workspaceMode="code" cwd="/work/goal-x" goalName="Ship the deck" />);
    expect(screen.getByRole("button", { name: "Ship the deck. Open the folder" })).toBeDefined();
  });
});
