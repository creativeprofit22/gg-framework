// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps } from "./AgentPane";
import type * as WorkspaceLayout from "./workspace-layout";
import { WorkspaceShell } from "./WorkspaceShell";

const workspaceLayoutMock = vi.hoisted(() => ({ rejectResolution: false }));

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

function setWorkspaceWidth(container: HTMLElement, width: number): void {
  const grid = container.querySelector<HTMLElement>(".workspace-grid");
  if (!grid) throw new Error("Workspace grid not found");
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({
    width,
    height: 700,
    top: 0,
    right: width,
    bottom: 700,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceLayoutMock.rejectResolution = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it("persists one-pane mode across restart and reopens into project selection", async () => {
    const first = render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout:main") ?? "null");
      expect(saved).toMatchObject({ version: 2, secondaryOpen: false });
      expect(saved.panes.secondary).toBeNull();
    });
    first.unmount();

    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-primary");
    expect(screen.queryByTestId("pane-secondary")).toBeNull();

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
  it.each([
    ["malformed", "not-json"],
    ["future", JSON.stringify({ version: 99, panes: {} })],
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

  it("recovers the native primary when reading layout storage fails", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    render(<WorkspaceShell renderPane={renderNativeRestorePane} />);

    expect((await screen.findByTestId("restore-pane-primary")).dataset.source).toBe("native");
    expect(screen.getByTestId("restore-pane-secondary").dataset.source).toBe("picker");
    expect(bridge.validateWorkspaceTarget).not.toHaveBeenCalled();
    expect(getItem).toHaveBeenCalledWith("gg-workspace-layout:main");
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
