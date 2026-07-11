// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps } from "./AgentPane";
import type * as WorkspaceLayout from "./workspace-layout";
import { WorkspaceShell } from "./WorkspaceShell";

const workspaceLayoutMock = vi.hoisted(() => ({ rejectResolution: false }));
const toastMock = vi.hoisted(() => vi.fn(() => 1));
const terminalMock = vi.hoisted(() => ({
  mounts: vi.fn(),
  unmounts: vi.fn(),
  heights: [] as number[],
  onHeightChange: undefined as ((height: number) => void) | undefined,
  onStartupFailure: undefined as (() => void) | undefined,
}));

const bridge = vi.hoisted(() => ({
  arrangeAllWindows: vi.fn(() => Promise.resolve()),
  focusWindowByOffset: vi.fn(() => Promise.resolve()),
  newWindow: vi.fn(() => Promise.resolve()),
  onWindowOrder: vi.fn(() => Promise.resolve(() => undefined)),
  setWindowTitle: vi.fn(),
  validateWorkspaceTarget: vi.fn(() =>
    Promise.resolve({ projectExists: true, sessionExists: true }),
  ),
  onDragDropEvent: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("./workspace-layout", async () => {
  const actual = await vi.importActual<typeof WorkspaceLayout>("./workspace-layout");
  return {
    ...actual,
    resolveWorkspaceLayoutTargets: (
      ...args: Parameters<typeof actual.resolveWorkspaceLayoutTargets>
    ) =>
      workspaceLayoutMock.rejectResolution
        ? Promise.reject(new Error("layout resolution failed"))
        : actual.resolveWorkspaceLayoutTargets(...args),
  };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: bridge.onDragDropEvent }),
}));
vi.mock("./agent", () => ({
  arrangeAllWindows: bridge.arrangeAllWindows,
  focusWindowByOffset: bridge.focusWindowByOffset,
  newWindow: bridge.newWindow,
  onWindowOrder: bridge.onWindowOrder,
  setWindowTitle: bridge.setWindowTitle,
  validateWorkspaceTarget: bridge.validateWorkspaceTarget,
  windowLabel: "main",
}));
vi.mock("./update", () => ({
  useAppUpdate: () => ({
    phase: "idle",
    version: null,
    localPatched: false,
    installTitle: "",
    install: vi.fn(),
    statusMessage: null,
    progressLines: [],
  }),
}));
vi.mock("./useProgress", () => ({
  useProgress: () => ({ snapshot: null, levelUp: null, levelUpNonce: null, levelUpOrigin: false }),
}));
vi.mock("./ProjectNotes", () => ({
  ProjectNotes: ({ cwd }: { cwd: string | null }) => (
    <div data-testid="notes" data-cwd={cwd ?? ""} />
  ),
}));
vi.mock("./Confetti", () => ({ Confetti: () => null }));
vi.mock("./Toaster", () => ({ Toaster: () => null }));
vi.mock("./toast", () => ({ toast: toastMock }));
vi.mock("./TerminalPane", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPane: ({
      paneId,
      height,
      onHeightChange,
      onRequestClose,
      onRunningChange,
      onStartupFailure,
    }: {
      paneId: string;
      height: number;
      onHeightChange(height: number): void;
      onRequestClose(running: boolean): void;
      onRunningChange?(running: boolean): void;
      onStartupFailure?(): void;
    }) => {
      terminalMock.heights.push(height);
      terminalMock.onHeightChange = onHeightChange;
      terminalMock.onStartupFailure = onStartupFailure;
      useEffect(() => {
        terminalMock.mounts(paneId);
        onRunningChange?.(true);
        return () => {
          terminalMock.unmounts(paneId);
          onRunningChange?.(false);
        };
      }, [onRunningChange, paneId]);
      return (
        <div className="terminal-pane" data-testid={`terminal-${paneId}`}>
          <input aria-label={`${paneId} terminal input`} />
          <button onClick={() => onRequestClose(true)}>Mock terminal close</button>
        </div>
      );
    },
  };
});

function FakePane({
  paneId,
  kind,
  focused,
  initialTarget,
  onFocus,
  onSnapshot,
  registerInput,
}: AgentPaneProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mountedTarget] = useState(initialTarget);
  useEffect(() => {
    registerInput(paneId, {
      focus: () => inputRef.current?.focus(),
      handleNativeDrop: () => undefined,
    });
    onSnapshot({
      paneId,
      cwd: `/work/${paneId}`,
      sessionPath: `/sessions/${paneId}.jsonl`,
      sessionTitle: paneId,
      projectBound: true,
      restoreChecked: true,
      activeWork: false,
    });
    return () => registerInput(paneId, null);
  }, [onSnapshot, paneId, registerInput]);

  return (
    <div
      data-testid={`pane-${paneId}`}
      data-kind={kind}
      data-focused={String(focused)}
      data-initial-mode={
        mountedTarget === undefined ? "native" : mountedTarget === null ? "picker" : "managed"
      }
      data-initial-cwd={mountedTarget?.cwd ?? ""}
      data-initial-session={mountedTarget?.sessionPath ?? ""}
      onPointerDown={() => onFocus(paneId)}
      onFocusCapture={() => onFocus(paneId)}
    >
      <input ref={inputRef} aria-label={`${paneId} input`} />
    </div>
  );
}

const renderPane = (props: AgentPaneProps): React.ReactNode => <FakePane {...props} />;

const nativePrimaryTarget = { cwd: "/native/project", sessionPath: "/native/session.jsonl" };

function NativeRestoreBoundaryPane({
  kind,
  initialTarget,
  onSnapshot,
  paneId,
}: AgentPaneProps): React.ReactElement {
  const recoveredTarget =
    kind === "primary" && initialTarget === undefined ? nativePrimaryTarget : null;
  useEffect(() => {
    onSnapshot({
      paneId,
      cwd: recoveredTarget?.cwd ?? null,
      sessionPath: recoveredTarget?.sessionPath ?? null,
      sessionTitle: null,
      projectBound: recoveredTarget !== null,
      restoreChecked: true,
      activeWork: false,
    });
  }, [onSnapshot, paneId, recoveredTarget]);

  return (
    <div
      data-testid={`restore-pane-${paneId}`}
      data-source={recoveredTarget ? "native" : "picker"}
      data-cwd={recoveredTarget?.cwd ?? ""}
    />
  );
}

const renderNativeRestorePane = (props: AgentPaneProps): React.ReactNode => (
  <NativeRestoreBoundaryPane {...props} />
);

function setWorkspaceSize(container: HTMLElement, width: number, height = 700): void {
  const grid = container.querySelector<HTMLElement>(".workspace-grid");
  if (!grid) throw new Error("Workspace grid not found");
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function setWorkspaceWidth(container: HTMLElement, width: number): void {
  setWorkspaceSize(container, width);
}

beforeEach(() => {
  vi.clearAllMocks();
  terminalMock.heights = [];
  terminalMock.onHeightChange = undefined;
  terminalMock.onStartupFailure = undefined;
  workspaceLayoutMock.rejectResolution = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceShell recursive rendering", () => {
  it("renders a vertical v6 split with normalized row ratios and horizontal separator semantics", async () => {
    localStorage.setItem(
      "gg-workspace-layout-recursive:main",
      JSON.stringify({
        version: 6,
        root: {
          type: "split",
          direction: "vertical",
          ratio: 35,
          first: { type: "leaf", paneId: "primary" },
          second: { type: "leaf", paneId: "secondary" },
        },
        focusedPaneId: "primary",
        panes: { primary: null, secondary: null },
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      }),
    );

    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    const split = container.querySelector<HTMLElement>(".workspace-split-vertical");
    expect(split?.style.gridTemplateRows).toBe("35fr 9px 65fr");
    expect(split?.querySelector('[role="separator"]')?.getAttribute("aria-orientation")).toBe(
      "horizontal",
    );
  });

  it("preserves a vertical v6 root through snapshots, focus, and terminal updates, then intentionally replaces it on close and reopen", async () => {
    const storageKey = "gg-workspace-layout-recursive:main";
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 6,
        root: {
          type: "split",
          direction: "vertical",
          ratio: 35,
          first: { type: "leaf", paneId: "primary" },
          second: { type: "leaf", paneId: "secondary" },
        },
        focusedPaneId: "primary",
        panes: { primary: null, secondary: null },
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      }),
    );
    render(<WorkspaceShell renderPane={renderPane} />);

    await screen.findByTestId("pane-secondary");
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(storageKey)!);
      expect(saved.root).toMatchObject({ direction: "vertical", ratio: 35 });
      expect(saved.panes.primary.cwd).toBe("/work/primary");
    });

    fireEvent.pointerDown(screen.getByTestId("pane-secondary"));
    fireEvent.click(screen.getByRole("button", { name: "Open terminal in focused pane" }));
    await screen.findByTestId("terminal-secondary");
    act(() => terminalMock.onHeightChange?.(340));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(storageKey)!);
      expect(saved.root).toMatchObject({ direction: "vertical", ratio: 35 });
      expect(saved.focusedPaneId).toBe("secondary");
      expect(saved.terminal).toMatchObject({
        open: true,
        ownerPaneId: "secondary",
        dockHeightPx: 340,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey)!).root).toEqual({
        type: "leaf",
        paneId: "primary",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open secondary pane" }));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(storageKey)!).root).toMatchObject({
        direction: "horizontal",
        ratio: 50,
      });
    });
  });

  it("falls back from a nested tree containing an unsupported leaf without mounting another agent", async () => {
    localStorage.setItem(
      "gg-workspace-layout-recursive:main",
      JSON.stringify({
        version: 6,
        root: {
          type: "split",
          direction: "horizontal",
          ratio: 40,
          first: { type: "leaf", paneId: "primary" },
          second: {
            type: "split",
            direction: "vertical",
            ratio: 60,
            first: { type: "leaf", paneId: "secondary" },
            second: { type: "leaf", paneId: "tertiary" },
          },
        },
        focusedPaneId: "tertiary",
        panes: { primary: null, secondary: null, tertiary: null },
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      }),
    );
    const mounted = vi.fn();

    render(
      <WorkspaceShell
        renderPane={(props) => {
          mounted(props.paneId);
          return <FakePane {...props} />;
        }}
      />,
    );

    await screen.findByTestId("pane-secondary");
    expect(screen.queryByTestId("pane-tertiary")).toBeNull();
    expect(new Set(mounted.mock.calls.map(([paneId]) => paneId))).toEqual(
      new Set(["primary", "secondary"]),
    );
    expect(document.querySelectorAll(".workspace-split")).toHaveLength(1);
  });
});

describe("WorkspaceShell pane routing", () => {
  it("renders exactly two stable primary/secondary columns with primary initially focused", async () => {
    const { container, rerender } = render(<WorkspaceShell renderPane={renderPane} />);
    const slots = [...container.querySelectorAll<HTMLElement>(".workspace-pane-slot")];

    expect(slots.map((slot) => slot.dataset.paneId)).toEqual(["primary", "secondary"]);
    expect(screen.getByTestId("pane-primary").dataset.kind).toBe("primary");
    expect(screen.getByTestId("pane-secondary").dataset.kind).toBe("secondary");
    expect(screen.getByTestId("pane-primary").dataset.focused).toBe("true");
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("false");

    const originalSlots = slots;
    rerender(<WorkspaceShell renderPane={renderPane} />);
    expect([...container.querySelectorAll(".workspace-pane-slot")]).toEqual(originalSlots);
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/primary"));
  });

  it("restores secondary focus, title, and Notes after target hydration without remounting panes", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 3,
        splitRatio: 58,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: {
          primary: { cwd: "/saved/a", sessionPath: "/sessions/a.jsonl" },
          secondary: { cwd: "/saved/b", sessionPath: "/sessions/b.jsonl" },
        },
      }),
    );
    const mounts = { primary: vi.fn(), secondary: vi.fn() };
    function MountCountingPane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => mounts[props.kind](), [props.kind]);
      return <FakePane {...props} />;
    }

    render(<WorkspaceShell renderPane={(props) => <MountCountingPane {...props} />} />);

    expect(await screen.findByTestId("pane-secondary")).toBeTruthy();
    expect(screen.getByTestId("pane-primary").dataset.focused).toBe("false");
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/secondary"));
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("secondary"));
    expect(mounts.primary).toHaveBeenCalledTimes(1);
    expect(mounts.secondary).toHaveBeenCalledTimes(1);
  });

  it("moves one focus by pointer, focus, and Ctrl/Cmd+1/2 and gives Notes the focused cwd", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const primary = screen.getByRole("textbox", { name: "primary input" });
    const secondary = screen.getByRole("textbox", { name: "secondary input" });

    fireEvent.pointerDown(screen.getByTestId("pane-secondary"));
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/secondary"));

    fireEvent.focus(primary);
    expect(screen.getByTestId("pane-primary").dataset.focused).toBe("true");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(document.activeElement).toBe(secondary);
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(document.activeElement).toBe(primary);
    expect(screen.getByTestId("pane-primary").dataset.focused).toBe("true");
  });

  it("restores the last pane input when the native window regains focus", () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const secondary = screen.getByRole("textbox", { name: "secondary input" });
    fireEvent.focus(secondary);
    fireEvent.blur(window);
    document.body.focus();

    fireEvent.focus(window);

    expect(document.activeElement).toBe(secondary);
  });

  it("calls each native shortcut bridge exactly once", () => {
    render(<WorkspaceShell renderPane={renderPane} />);

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", metaKey: true });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "a", metaKey: true, shiftKey: true });

    expect(bridge.newWindow).toHaveBeenCalledTimes(1);
    expect(bridge.focusWindowByOffset).toHaveBeenNthCalledWith(1, 1);
    expect(bridge.focusWindowByOffset).toHaveBeenNthCalledWith(2, -1);
    expect(bridge.focusWindowByOffset).toHaveBeenCalledTimes(2);
    expect(bridge.arrangeAllWindows).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceShell terminal dock", () => {
  it("opens in the focused pane, pins its owner, and does not remount agent panes", async () => {
    const paneMounts = vi.fn();
    function CountingPane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => paneMounts(props.paneId), [props.paneId]);
      return <FakePane {...props} />;
    }
    render(<WorkspaceShell renderPane={(props) => <CountingPane {...props} />} />);
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    fireEvent.click(open);
    expect(screen.getByTestId("terminal-secondary")).toBeTruthy();
    expect(open.hasAttribute("disabled")).toBe(true);

    fireEvent.focus(screen.getByRole("textbox", { name: "primary input" }));
    expect(screen.getByTestId("terminal-secondary")).toBeTruthy();
    expect(screen.queryByTestId("terminal-primary")).toBeNull();
    expect(paneMounts).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "changes project", cwd: "/work/replacement", projectBound: true },
    { label: "becomes unbound", cwd: null, projectBound: false },
  ])("closes its owner-pinned terminal when the pane $label", async ({ cwd, projectBound }) => {
    const paneMounts = vi.fn();
    function ControllablePane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => paneMounts(props.paneId), [props.paneId]);
      return (
        <>
          <FakePane {...props} />
          {props.kind === "primary" && (
            <button
              onClick={() =>
                props.onSnapshot({
                  paneId: props.paneId,
                  cwd,
                  sessionPath: null,
                  sessionTitle: null,
                  projectBound,
                  restoreChecked: true,
                  activeWork: false,
                })
              }
            >
              Change primary project
            </button>
          )}
        </>
      );
    }

    render(<WorkspaceShell renderPane={(props) => <ControllablePane {...props} />} />);
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    expect(screen.getByTestId("terminal-primary")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Change primary project" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-primary")).toBeNull());
    expect(terminalMock.unmounts).toHaveBeenCalledTimes(1);
    expect(terminalMock.unmounts).toHaveBeenCalledWith("primary");

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    expect(screen.queryByTestId("terminal-secondary")).toBeNull();
    expect(paneMounts).toHaveBeenCalledTimes(2);
  });

  it("waits for the validated exact saved owner snapshot, starts once, and persists close", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 4,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: {
          primary: { cwd: "/saved/primary", sessionPath: null },
          secondary: { cwd: "/saved/owner", sessionPath: "/sessions/owner.jsonl" },
        },
        terminal: { open: true, ownerPaneId: "secondary" },
      }),
    );
    let emitOwnerSnapshot: (() => void) | undefined;
    const agentMounts = vi.fn();
    function DelayedOwnerPane({ kind, onSnapshot, paneId }: AgentPaneProps): React.ReactElement {
      useEffect(() => agentMounts(paneId), [paneId]);
      useEffect(() => {
        const snapshot = (cwd: string, sessionPath: string | null) =>
          onSnapshot({
            paneId,
            cwd,
            sessionPath,
            sessionTitle: paneId,
            projectBound: true,
            restoreChecked: true,
            activeWork: false,
          });
        if (kind === "primary") snapshot("/saved/primary", null);
        else emitOwnerSnapshot = () => snapshot("/saved/owner", "/sessions/owner.jsonl");
      }, [kind, onSnapshot, paneId]);
      return <div data-testid={`delayed-${paneId}`} />;
    }

    render(<WorkspaceShell renderPane={(props) => <DelayedOwnerPane {...props} />} />);
    await screen.findByTestId("delayed-secondary");
    expect(bridge.validateWorkspaceTarget).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("terminal-secondary")).toBeNull();
    emitOwnerSnapshot?.();
    expect(await screen.findByTestId("terminal-secondary")).toBeTruthy();
    expect(terminalMock.mounts).toHaveBeenCalledTimes(1);
    expect(terminalMock.mounts).toHaveBeenCalledWith("secondary");
    expect(agentMounts).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Mock terminal close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-secondary")).toBeNull());
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout:main") ?? "null");
      expect(saved.terminal).toEqual({ open: false, ownerPaneId: null, dockHeightPx: 260 });
    });
  });

  it("clears restored terminal intent after startup failure while keeping its error pane mounted", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 5,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "primary",
        panes: {
          primary: { cwd: "/work/primary", sessionPath: null },
          secondary: { cwd: "/work/secondary", sessionPath: null },
        },
        terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 410 },
      }),
    );

    render(<WorkspaceShell renderPane={renderPane} />);
    expect(await screen.findByTestId("terminal-primary")).toBeTruthy();
    act(() => terminalMock.onStartupFailure?.());

    expect(screen.getByTestId("terminal-primary")).toBeTruthy();
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout:main") ?? "null");
      expect(saved.terminal).toEqual({ open: false, ownerPaneId: null, dockHeightPx: 410 });
    });
  });

  it("clamps, saves, and restores terminal dock height across restart", async () => {
    const first = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceSize(first.container, 1_000, 1_000);
    fireEvent(window, new Event("resize"));
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    expect(terminalMock.heights[terminalMock.heights.length - 1]).toBe(260);

    terminalMock.onHeightChange?.(480);
    await waitFor(() => expect(terminalMock.heights[terminalMock.heights.length - 1]).toBe(480));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout:main") ?? "null");
      expect(saved.terminal.dockHeightPx).toBe(480);
    });

    first.unmount();
    terminalMock.heights = [];

    const restarted = render(<WorkspaceShell renderPane={renderPane} />);
    expect(await screen.findByTestId("terminal-primary")).toBeTruthy();
    expect(terminalMock.heights[terminalMock.heights.length - 1]).toBe(480);

    setWorkspaceSize(restarted.container, 1_000, 1_000);
    fireEvent(window, new Event("resize"));
    terminalMock.onHeightChange?.(50);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout:main") ?? "null");
      expect(saved.terminal.dockHeightPx).toBe(140);
    });
    expect(terminalMock.heights[terminalMock.heights.length - 1]).toBe(140);
    expect(toastMock).not.toHaveBeenCalledWith(
      "Saved terminal size was unavailable. A safe size was restored.",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("warns exactly once and restores a safe terminal height when the saved size is unavailable", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 5,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "primary",
        panes: {
          primary: { cwd: "/work/primary", sessionPath: null },
          secondary: { cwd: "/work/secondary", sessionPath: null },
        },
        terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 50 },
      }),
    );

    const view = render(<WorkspaceShell renderPane={renderPane} />);
    expect(await screen.findByTestId("terminal-primary")).toBeTruthy();
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Saved terminal size was unavailable. A safe size was restored.",
        "warning",
        4000,
        false,
      ),
    );
    expect(toastMock).toHaveBeenCalledTimes(1);
    view.rerender(<WorkspaceShell renderPane={renderPane} />);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh terminal when the saved agent session is missing", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 4,
        splitRatio: 50,
        secondaryOpen: false,
        focusedPaneId: "primary",
        panes: {
          primary: { cwd: "/saved/a", sessionPath: "/sessions/gone.jsonl" },
          secondary: null,
        },
        terminal: { open: true, ownerPaneId: "primary" },
      }),
    );
    bridge.validateWorkspaceTarget.mockResolvedValueOnce({
      projectExists: true,
      sessionExists: false,
    });
    function FreshPane({ onSnapshot, paneId }: AgentPaneProps): React.ReactElement {
      useEffect(() => {
        onSnapshot({
          paneId,
          cwd: "/saved/a",
          sessionPath: null,
          sessionTitle: null,
          projectBound: true,
          restoreChecked: true,
          activeWork: false,
        });
      }, [onSnapshot, paneId]);
      return <div data-testid="fresh-pane" />;
    }
    render(<WorkspaceShell renderPane={(props) => <FreshPane {...props} />} />);
    expect(await screen.findByTestId("terminal-primary")).toBeTruthy();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("uses only the required deduped warning when the saved terminal project is unavailable", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 4,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "primary",
        panes: { primary: { cwd: "/missing", sessionPath: null }, secondary: null },
        terminal: { open: true, ownerPaneId: "primary" },
      }),
    );
    bridge.validateWorkspaceTarget.mockResolvedValueOnce({
      projectExists: false,
      sessionExists: false,
    });
    const view = render(<WorkspaceShell renderPane={renderPane} />);
    const primary = await screen.findByTestId("pane-primary");
    expect(primary.dataset.initialMode).toBe("picker");
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Saved terminal project was unavailable. The terminal stayed closed.",
        "warning",
        4000,
        false,
      ),
    );
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalledWith(
      "Some saved workspace panes were unavailable. A safe layout was restored.",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(screen.queryByTestId("terminal-primary")).toBeNull();
    view.rerender(<WorkspaceShell renderPane={renderPane} />);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("isolates terminal shortcuts while reserving pane and window navigation", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    const input = screen.getByRole("textbox", { name: "primary terminal input" });

    fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    fireEvent.keyDown(input, { key: "a", ctrlKey: true, shiftKey: true });
    expect(bridge.newWindow).not.toHaveBeenCalled();
    expect(bridge.arrangeAllWindows).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "2", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "secondary input" }));
    fireEvent.keyDown(input, { key: "`", code: "Backquote", ctrlKey: true });
    expect(bridge.focusWindowByOffset).toHaveBeenCalledWith(1);
  });

  it("treats a secondary terminal as active when closing its pane", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    expect(
      screen.getByText(
        "Work is active in the secondary pane. Closing it will stop that session. Close anyway?",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-secondary")).toBeNull());
    expect(screen.queryByTestId("pane-secondary")).toBeNull();
  });
});

describe("WorkspaceShell secondary pane lifecycle", () => {
  it("disposes only secondary listeners/session state and restores primary focus", async () => {
    const disposed = { primary: vi.fn(), secondary: vi.fn() };
    function DisposablePane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => () => disposed[props.kind](), [props.kind]);
      return <FakePane {...props} />;
    }

    render(<WorkspaceShell renderPane={(props) => <DisposablePane {...props} />} />);
    const primaryInput = screen.getByRole("textbox", { name: "primary input" });
    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => expect(disposed.secondary).toHaveBeenCalledTimes(1));
    expect(disposed.primary).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(primaryInput));
    expect(screen.queryByTestId("pane-secondary")).toBeNull();
    expect(document.querySelector(".workspace-grid")?.getAttribute("data-pane-count")).toBe("1");
  });

  it("persists primary focus in one-pane mode and restores it across restart", async () => {
    const first = render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout:main") ?? "null");
      expect(saved).toMatchObject({
        version: 5,
        secondaryOpen: false,
        focusedPaneId: "primary",
      });
      expect(saved.panes.secondary).toBeNull();
    });
    first.unmount();

    render(<WorkspaceShell renderPane={renderPane} />);
    const primary = await screen.findByTestId("pane-primary");
    expect(primary.dataset.focused).toBe("true");
    expect(screen.queryByTestId("pane-secondary")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/primary"));
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("primary"));

    fireEvent.click(screen.getByRole("button", { name: "Open secondary pane" }));
    const secondary = await screen.findByTestId("pane-secondary");
    expect(secondary.dataset.initialMode).toBe("picker");
    expect(screen.getByRole("button", { name: "Close secondary pane" })).toBeTruthy();
  });

  it("supports repeated close and reopen without duplicating secondary mounts", async () => {
    const mounts = vi.fn();
    const disposals = vi.fn();
    function CountingPane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => {
        if (props.kind === "secondary") mounts();
        return () => {
          if (props.kind === "secondary") disposals();
        };
      }, [props.kind]);
      return <FakePane {...props} />;
    }

    render(<WorkspaceShell renderPane={(props) => <CountingPane {...props} />} />);
    expect(mounts).toHaveBeenCalledTimes(1);

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
      await waitFor(() => expect(disposals).toHaveBeenCalledTimes(cycle));
      fireEvent.click(screen.getByRole("button", { name: "Open secondary pane" }));
      await screen.findByTestId("pane-secondary");
      expect(mounts).toHaveBeenCalledTimes(cycle + 1);
      expect(screen.getAllByTestId("pane-secondary")).toHaveLength(1);
    }
  });

  it("requires confirmation before closing active work and keeps both panes on cancel", async () => {
    function ActivePane({ kind, onSnapshot, paneId }: AgentPaneProps): React.ReactElement {
      useEffect(() => {
        onSnapshot({
          paneId,
          cwd: `/work/${paneId}`,
          sessionPath: `/sessions/${paneId}.jsonl`,
          sessionTitle: paneId,
          projectBound: true,
          restoreChecked: true,
          activeWork: kind === "secondary",
        });
      }, [kind, onSnapshot, paneId]);
      return <div data-testid={`active-${paneId}`} />;
    }

    render(<WorkspaceShell renderPane={(props) => <ActivePane {...props} />} />);
    await screen.findByTestId("active-secondary");
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    expect(
      screen.getByText(
        "Work is active in the secondary pane. Closing it will stop that session. Close anyway?",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("active-secondary")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));
    await waitFor(() => expect(screen.queryByTestId("active-secondary")).toBeNull());
    expect(screen.getByTestId("active-primary")).toBeTruthy();
  });
});

describe("WorkspaceShell layout recovery", () => {
  it("warns once for a malformed layout across rerenders and keeps the pane usable", async () => {
    localStorage.setItem("gg-workspace-layout:main", "not-json");

    const view = render(<WorkspaceShell renderPane={renderPane} />);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Saved workspace layout was invalid. A safe layout was restored.",
        "warning",
        4000,
        false,
      ),
    );
    const primaryInput = screen.getByRole("textbox", { name: "primary input" });
    primaryInput.focus();
    expect(document.activeElement).toBe(primaryInput);

    view.rerender(<WorkspaceShell renderPane={renderPane} />);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("warns once when a stale target falls back and keeps the recovered pane usable", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 3,
        splitRatio: 50,
        secondaryOpen: false,
        focusedPaneId: "primary",
        panes: { primary: { cwd: "/missing", sessionPath: null }, secondary: null },
      }),
    );
    bridge.validateWorkspaceTarget.mockResolvedValueOnce({
      projectExists: false,
      sessionExists: false,
    });

    const view = render(<WorkspaceShell renderPane={renderPane} />);

    const primary = await screen.findByTestId("pane-primary");
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Some saved workspace panes were unavailable. A safe layout was restored.",
        "warning",
        4000,
        false,
      ),
    );
    expect(primary.dataset.initialMode).toBe("picker");
    fireEvent.pointerDown(primary);
    expect(primary.dataset.focused).toBe("true");

    view.rerender(<WorkspaceShell renderPane={renderPane} />);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("warns again for a later distinct recovery event", async () => {
    localStorage.setItem("gg-workspace-layout:main", "first-invalid-layout");
    const first = render(<WorkspaceShell renderPane={renderPane} />);
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    first.unmount();

    localStorage.setItem("gg-workspace-layout:main", "second-invalid-layout");
    render(<WorkspaceShell renderPane={renderPane} />);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["absent", undefined],
    ["malformed", 42],
    ["unknown", "tertiary"],
  ])("falls back to primary focus for %s persisted focus", async (_label, focusedPaneId) => {
    const record: Record<string, unknown> = {
      version: 3,
      splitRatio: 50,
      secondaryOpen: true,
      focusedPaneId,
      panes: {
        primary: { cwd: "/saved/a", sessionPath: null },
        secondary: { cwd: "/saved/b", sessionPath: null },
      },
    };
    if (focusedPaneId === undefined) delete record.focusedPaneId;
    localStorage.setItem("gg-workspace-layout:main", JSON.stringify(record));

    render(<WorkspaceShell renderPane={renderPane} />);

    expect((await screen.findByTestId("pane-primary")).dataset.focused).toBe("true");
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("false");
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/primary"));
  });

  it("falls back to one focused primary pane for stale closed-secondary focus", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 3,
        splitRatio: 50,
        secondaryOpen: false,
        focusedPaneId: "secondary",
        panes: { primary: { cwd: "/saved/a", sessionPath: null }, secondary: null },
      }),
    );

    render(<WorkspaceShell renderPane={renderPane} />);

    expect((await screen.findByTestId("pane-primary")).dataset.focused).toBe("true");
    expect(screen.queryByTestId("pane-secondary")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/primary"));
  });
  it.each([
    ["malformed", "not-json"],
    ["future", ' \n{\r\n  "version": 99, "future": "é\\u0000"\r\n}\t'],
  ])("recovers the native primary and secondary picker for %s layouts", async (_label, raw) => {
    localStorage.setItem("gg-workspace-layout:main", raw);

    render(<WorkspaceShell renderPane={renderNativeRestorePane} />);

    const primary = await screen.findByTestId("restore-pane-primary");
    expect(primary.dataset.source).toBe("native");
    expect(primary.dataset.cwd).toBe(nativePrimaryTarget.cwd);
    expect(screen.getByTestId("restore-pane-secondary").dataset.source).toBe("picker");
    expect(screen.getByRole("separator").parentElement?.getAttribute("data-split-ratio")).toBe(
      "50",
    );
    expect(bridge.validateWorkspaceTarget).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(raw);
      expect(localStorage.getItem("gg-workspace-layout:main")).toBe(raw);
    });
  });

  it("preserves malformed legacy bytes only in the legacy diagnostic", async () => {
    const legacyRaw = " \nlegacy-invalid-é\\u0000\t";
    const recursiveDiagnostic = "existing-recursive-diagnostic";
    localStorage.setItem("gg-workspace-layout:main", legacyRaw);
    localStorage.setItem("gg-workspace-layout-rejected:main", "existing-legacy-diagnostic");
    localStorage.setItem("gg-workspace-layout-recursive-rejected:main", recursiveDiagnostic);

    render(<WorkspaceShell renderPane={renderNativeRestorePane} />);
    await screen.findByTestId("restore-pane-primary");

    await waitFor(() =>
      expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(legacyRaw),
    );
    expect(localStorage.getItem("gg-workspace-layout-recursive-rejected:main")).toBe(
      recursiveDiagnostic,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open terminal in focused pane" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!).version).toBe(
        6,
      ),
    );
    expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(legacyRaw);
    expect(localStorage.getItem("gg-workspace-layout-recursive-rejected:main")).toBe(
      recursiveDiagnostic,
    );
  });

  it("preserves malformed recursive bytes only in the recursive diagnostic", async () => {
    const recursiveRaw = ' \n{"version":99,"future":"é\\u0000"}\t';
    const legacyDiagnostic = "existing-legacy-diagnostic";
    localStorage.setItem("gg-workspace-layout-recursive:main", recursiveRaw);
    localStorage.setItem("gg-workspace-layout-rejected:main", legacyDiagnostic);
    localStorage.setItem(
      "gg-workspace-layout-recursive-rejected:main",
      "existing-recursive-diagnostic",
    );

    render(<WorkspaceShell renderPane={renderNativeRestorePane} />);
    await screen.findByTestId("restore-pane-primary");

    await waitFor(() =>
      expect(localStorage.getItem("gg-workspace-layout-recursive-rejected:main")).toBe(
        recursiveRaw,
      ),
    );
    expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(legacyDiagnostic);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal in focused pane" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!).version).toBe(
        6,
      ),
    );
    expect(localStorage.getItem("gg-workspace-layout-recursive-rejected:main")).toBe(recursiveRaw);
    expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(legacyDiagnostic);
  });

  it("keeps the rollback write barrier until user layout interaction", async () => {
    const raw = '{"version":99,"future":true}';
    localStorage.setItem("gg-workspace-layout:main", raw);

    render(<WorkspaceShell renderPane={renderNativeRestorePane} />);
    await screen.findByTestId("restore-pane-primary");
    await waitFor(() =>
      expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(raw),
    );
    expect(localStorage.getItem("gg-workspace-layout:main")).toBe(raw);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal in focused pane" }));

    await waitFor(() => {
      const saved = localStorage.getItem("gg-workspace-layout:main");
      expect(saved).not.toBe(raw);
      expect(JSON.parse(saved!)).toMatchObject({
        version: 5,
        focusedPaneId: "primary",
        terminal: { open: true, ownerPaneId: "primary" },
      });
    });
    expect(localStorage.getItem("gg-workspace-layout-rejected:main")).toBe(raw);
  });

  it("recovers from a recursive layout storage load failure and warns once across rerenders", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const { rerender } = render(<WorkspaceShell renderPane={renderNativeRestorePane} />);

    expect((await screen.findByTestId("restore-pane-primary")).dataset.source).toBe("native");
    expect(screen.getByTestId("restore-pane-secondary").dataset.source).toBe("picker");
    expect(bridge.validateWorkspaceTarget).not.toHaveBeenCalled();
    expect(getItem.mock.calls).toEqual([["gg-workspace-layout-recursive:main"]]);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Saved workspace layout could not be loaded. A safe layout was restored.",
        "warning",
        4000,
        false,
      ),
    );
    expect(toastMock).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceShell renderPane={renderNativeRestorePane} />);

    expect(screen.getByTestId("restore-pane-primary").dataset.source).toBe("native");
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("reads the legacy layout only when the recursive layout is absent", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);

    render(<WorkspaceShell renderPane={renderNativeRestorePane} />);

    expect((await screen.findByTestId("restore-pane-primary")).dataset.source).toBe("native");
    expect(screen.getByTestId("restore-pane-secondary").dataset.source).toBe("picker");
    expect(getItem.mock.calls).toEqual([
      ["gg-workspace-layout-recursive:main"],
      ["gg-workspace-layout:main"],
    ]);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("restores the saved ratio and both pane targets before mounting panes", async () => {
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 1,
        splitRatio: 64,
        panes: {
          primary: { cwd: "/saved/a", sessionPath: "/sessions/a.jsonl" },
          secondary: { cwd: "/saved/b", sessionPath: "/sessions/b.jsonl" },
        },
      }),
    );

    render(<WorkspaceShell renderPane={renderPane} />);

    const divider = await screen.findByRole("separator", { name: "Resize workspace panes" });
    await waitFor(() =>
      expect(screen.getByTestId("pane-primary").dataset.initialCwd).toBe("/saved/a"),
    );
    expect(screen.getByTestId("pane-secondary").dataset.initialSession).toBe("/sessions/b.jsonl");
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    expect(divider.parentElement?.getAttribute("data-split-ratio")).toBe("64");
    expect(bridge.validateWorkspaceTarget).toHaveBeenCalledTimes(2);
  });

  it("mounts the saved targets when layout validation fails unexpectedly", async () => {
    workspaceLayoutMock.rejectResolution = true;
    localStorage.setItem(
      "gg-workspace-layout:main",
      JSON.stringify({
        version: 1,
        splitRatio: 64,
        panes: {
          primary: { cwd: "/saved/a", sessionPath: "/sessions/a.jsonl" },
          secondary: { cwd: "/saved/b", sessionPath: "/sessions/b.jsonl" },
        },
      }),
    );

    render(<WorkspaceShell renderPane={renderPane} />);

    expect((await screen.findByTestId("pane-primary")).dataset.initialCwd).toBe("/saved/a");
    expect(screen.getByTestId("pane-secondary").dataset.initialCwd).toBe("/saved/b");
    expect(screen.getByRole("separator").parentElement?.getAttribute("data-split-ratio")).toBe(
      "64",
    );
  });
});

describe("WorkspaceShell pane resizing", () => {
  it("applies pointer drag deltas relative to the available pane width", () => {
    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize workspace panes" });

    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 600, pointerId: 7 });

    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
  });

  it("clamps pointer resizing to a 280px minimum for each pane", () => {
    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize workspace panes" });

    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 8 });
    fireEvent.pointerMove(window, { clientX: -5_000, pointerId: 8 });
    expect(divider.getAttribute("aria-valuenow")).toBe("28");

    fireEvent.pointerMove(window, { clientX: 5_000, pointerId: 8 });
    expect(divider.getAttribute("aria-valuenow")).toBe("72");
  });

  it("supports arrow, accelerated arrow, Home, and End keyboard controls", () => {
    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize workspace panes" });

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(divider.getAttribute("aria-valuenow")).toBe("62");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(divider.getAttribute("aria-valuenow")).toBe("28");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("72");
  });

  it("removes global pointer listeners when dragging ends and when the shell unmounts", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { container, unmount } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize workspace panes" });
    addListener.mockClear();
    removeListener.mockClear();

    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 9 });
    expect(addListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(addListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(addListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));

    fireEvent.pointerUp(window, { pointerId: 9 });
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));

    removeListener.mockClear();
    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 10 });
    unmount();
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});
