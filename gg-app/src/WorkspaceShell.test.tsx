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
}));

const bridge = vi.hoisted(() => ({
  arrangeAllWindows: vi.fn(() => Promise.resolve()),
  focusWindowByOffset: vi.fn(() => Promise.resolve()),
  newWindow: vi.fn(() => Promise.resolve()),
  openPaneInNewWindow: vi.fn(() => Promise.resolve()),
  onWindowOrder: vi.fn(() => Promise.resolve(() => undefined)),
  setWindowTitle: vi.fn(),
  validateWorkspaceTarget: vi.fn(() =>
    Promise.resolve({ projectExists: true, sessionExists: true }),
  ),
  onDragDropEvent: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("./AgentPane", () => ({ AgentPane: () => null }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

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
  openPaneInNewWindow: bridge.openPaneInNewWindow,
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
      initiallyStopped,
      onRestart,
      onRequestClose,
      onRunningChange,
    }: {
      paneId: string;
      initiallyStopped?: boolean;
      onRestart?(): void;
      onRequestClose(running: boolean): void;
      onRunningChange?(running: boolean): void;
    }) => {
      const [stopped, setStopped] = useState(Boolean(initiallyStopped));
      useEffect(() => {
        if (stopped) return;
        terminalMock.mounts(paneId);
        onRunningChange?.(true);
        return () => {
          terminalMock.unmounts(paneId);
          onRunningChange?.(false);
        };
      }, [onRunningChange, paneId, stopped]);
      return (
        <div className="terminal-pane" data-testid={`terminal-${paneId}`}>
          {stopped ? (
            <button
              onClick={() => {
                onRestart?.();
                setStopped(false);
              }}
            >
              Restart terminal
            </button>
          ) : (
            <input aria-label={`${paneId} terminal input`} />
          )}
          <button onClick={() => onRequestClose(!stopped)}>Mock terminal close</button>
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
      cwd: mountedTarget === null ? null : `/work/${paneId}`,
      sessionPath: mountedTarget === null ? null : `/sessions/${paneId}.jsonl`,
      sessionTitle: mountedTarget === null ? null : paneId,
      projectBound: mountedTarget !== null,
      restoreChecked: true,
      activeWork: false,
    });
    return () => registerInput(paneId, null);
  }, [mountedTarget, onSnapshot, paneId, registerInput]);

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

function PickerAwarePane({
  paneId,
  kind,
  focused,
  initialTarget,
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
    if (mountedTarget !== null) {
      onSnapshot({
        paneId,
        cwd: `/work/${paneId}`,
        sessionPath: null,
        sessionTitle: paneId,
        projectBound: true,
        restoreChecked: true,
        activeWork: false,
      });
    }
    return () => registerInput(paneId, null);
  }, [mountedTarget, onSnapshot, paneId, registerInput]);
  return (
    <div
      data-testid={`pane-${paneId}`}
      data-kind={kind}
      data-focused={String(focused)}
      data-initial-mode={mountedTarget === null ? "picker" : "native"}
    >
      <input ref={inputRef} />
    </div>
  );
}

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
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.clearAllMocks();
  bridge.openPaneInNewWindow.mockResolvedValue(undefined);
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

  it.each([
    ["right", "Split Right", "horizontal"],
    ["down", "Split Down", "vertical"],
  ])(
    "split %s creates exactly one focused null-target auxiliary pane without remounting unrelated panes",
    async (_label, action, direction) => {
      const mounts = vi.fn();
      function CountingPane(props: AgentPaneProps): React.ReactElement {
        useEffect(() => mounts(props.paneId), [props.paneId]);
        return <PickerAwarePane {...props} />;
      }
      render(<WorkspaceShell renderPane={(props) => <CountingPane {...props} />} />);
      const primary = screen.getByTestId("pane-primary");
      fireEvent.pointerDown(primary);
      mounts.mockClear();
      fireEvent.click(screen.getByRole("button", { name: action }));
      const created = await screen.findByTestId("pane-pane-1");
      expect(created.dataset.kind).toBe("auxiliary");
      expect(created.dataset.focused).toBe("true");
      expect(created.dataset.initialMode).toBe("picker");
      expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(3);
      expect(
        document.querySelectorAll(`.workspace-split-${direction}`).length,
      ).toBeGreaterThanOrEqual(1);
      expect(mounts.mock.calls.filter(([paneId]) => paneId === "pane-1")).toHaveLength(1);
      expect(mounts).not.toHaveBeenCalledWith("secondary");
      expect(screen.getByTestId("pane-primary")).toBeTruthy();
    },
  );

  it("preserves a newly bound legacy auxiliary target when splitting that pane", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const secondary = await screen.findByTestId("pane-secondary");
    fireEvent.pointerDown(secondary);
    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-secondary").dataset.initialMode).toBe("managed");
      expect(screen.getByTestId("pane-secondary").dataset.initialCwd).toBe("/work/secondary");
    });
    expect(screen.getByTestId("pane-pane-1").dataset.initialMode).toBe("picker");
  });

  it("supports dynamic nested leaves instead of discarding them", async () => {
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
        panes: {
          primary: { cwd: "/work/primary", sessionPath: null },
          secondary: { cwd: "/work/secondary", sessionPath: null },
          tertiary: { cwd: "/work/tertiary", sessionPath: null },
        },
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      }),
    );
    render(<WorkspaceShell renderPane={renderPane} />);
    const tertiary = await screen.findByTestId("pane-tertiary");
    expect(tertiary.dataset.kind).toBe("auxiliary");
    expect(tertiary.dataset.focused).toBe("true");
    expect(document.querySelectorAll(".workspace-split")).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/tertiary"));
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("tertiary"));
  });
});

describe("WorkspaceShell v7 terminal rendering", () => {
  function saveStoppedTerminalLayout(
    focusedPaneId = "primary",
    terminalSessionPath: string | null = null,
  ): void {
    localStorage.setItem(
      "gg-workspace-layout-recursive:main",
      JSON.stringify({
        version: 7,
        root: {
          type: "split",
          direction: "vertical",
          size: { type: "fixed-second", pixels: 260 },
          first: { type: "leaf", paneId: "primary" },
          second: { type: "leaf", paneId: "terminal-1" },
        },
        focusedPaneId,
        panes: {
          primary: { kind: "agent", cwd: "/work/primary", sessionPath: null },
          "terminal-1": {
            kind: "terminal",
            stopped: true,
            cwd: "/work/primary",
            sessionPath: terminalSessionPath,
          },
        },
      }),
    );
  }

  it("renders a persisted terminal leaf stopped and creates one PTY only after Restart", async () => {
    saveStoppedTerminalLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByTestId("terminal-terminal-1")).toBeTruthy();
    expect(screen.getAllByTestId("terminal-terminal-1")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
    expect(terminalMock.mounts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));

    await waitFor(() => expect(terminalMock.mounts).toHaveBeenCalledOnce());
    expect(terminalMock.mounts).toHaveBeenCalledWith("terminal-1");
  });

  it.each([
    ["right", "Split Right", "horizontal"],
    ["down", "Split Down", "vertical"],
  ])(
    "splits a focused terminal %s, copies its target, focuses and persists it without a PTY",
    async (_label, action, direction) => {
      saveStoppedTerminalLayout("terminal-1", "/sessions/source.jsonl");
      render(<WorkspaceShell renderPane={renderPane} />);
      await screen.findByTestId("terminal-terminal-1");
      await screen.findByTestId("pane-primary");

      fireEvent.click(screen.getByRole("button", { name: action }));

      expect(await screen.findByTestId("terminal-terminal-2")).toBeTruthy();
      expect(document.querySelector('[data-pane-id="terminal-2"]')?.classList).toContain(
        "pane-focused",
      );
      expect(document.querySelectorAll(`.workspace-split-${direction}`).length).toBeGreaterThan(0);
      expect(terminalMock.mounts).not.toHaveBeenCalled();
      await waitFor(() => {
        const saved = JSON.parse(
          localStorage.getItem("gg-workspace-layout-recursive:main") ?? "null",
        );
        expect(saved.focusedPaneId).toBe("terminal-2");
        expect(saved.panes["terminal-2"]).toEqual({
          kind: "terminal",
          stopped: true,
          cwd: "/work/primary",
          sessionPath: "/sessions/source.jsonl",
        });
      });
    },
  );

  it("creates, focuses, and persists two uniquely identified stopped terminal leaves", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));

    fireEvent.click(open);
    expect(await screen.findByTestId("terminal-terminal-1")).toBeTruthy();
    expect(document.querySelector('[data-pane-id="terminal-1"]')?.classList).toContain(
      "pane-focused",
    );
    expect(terminalMock.mounts).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByTestId("pane-primary"));
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);

    expect(await screen.findByTestId("terminal-terminal-2")).toBeTruthy();
    expect(document.querySelector('[data-pane-id="terminal-2"]')?.classList).toContain(
      "pane-focused",
    );
    expect(terminalMock.mounts).not.toHaveBeenCalled();
    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("gg-workspace-layout-recursive:main") ?? "null",
      );
      expect(saved.focusedPaneId).toBe("terminal-2");
      expect(saved.panes["terminal-1"]).toMatchObject({
        kind: "terminal",
        stopped: true,
        cwd: "/work/primary",
      });
      expect(saved.panes["terminal-2"]).toMatchObject({
        kind: "terminal",
        stopped: true,
        cwd: "/work/primary",
      });
    });
  });

  it("closes one running terminal without touching another", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    await screen.findByTestId("terminal-terminal-1");
    fireEvent.pointerDown(screen.getByTestId("pane-primary"));
    fireEvent.click(open);
    await screen.findByTestId("terminal-terminal-2");

    fireEvent.click(screen.getAllByRole("button", { name: "Restart terminal" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Restart terminal" })[0]);
    await waitFor(() => expect(terminalMock.mounts).toHaveBeenCalledTimes(2));
    terminalMock.unmounts.mockClear();
    const second = screen.getByTestId("terminal-terminal-2");
    fireEvent.click(second.querySelector("button")!);
    expect(
      screen.getByText(
        "A shell is still running. Closing the terminal will stop it and its child processes.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));

    await waitFor(() => expect(screen.queryByTestId("terminal-terminal-2")).toBeNull());
    expect(screen.getByTestId("terminal-terminal-1")).toBeTruthy();
    expect(terminalMock.unmounts).toHaveBeenCalledWith("terminal-2");
    expect(terminalMock.unmounts).not.toHaveBeenCalledWith("terminal-1");
  });

  it("keeps terminal leaves when their former agent sibling closes", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.pointerDown(screen.getByTestId("pane-secondary"));
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    await screen.findByTestId("terminal-terminal-1");
    fireEvent.pointerDown(screen.getByTestId("pane-secondary"));
    fireEvent.click(open);
    await screen.findByTestId("terminal-terminal-2");

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());
    expect(screen.getByTestId("terminal-terminal-1")).toBeTruthy();
    expect(screen.getByTestId("terminal-terminal-2")).toBeTruthy();
    expect(terminalMock.unmounts).not.toHaveBeenCalled();
  });

  it("restores every persisted terminal stopped after reload", async () => {
    const view = render(<WorkspaceShell renderPane={renderPane} />);
    const open = screen.getByRole("button", { name: "Open terminal in focused pane" });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    await screen.findByTestId("terminal-terminal-1");
    fireEvent.pointerDown(screen.getByTestId("pane-primary"));
    fireEvent.click(open);
    await screen.findByTestId("terminal-terminal-2");
    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("gg-workspace-layout-recursive:main") ?? "null",
      );
      expect(saved.panes["terminal-2"]?.stopped).toBe(true);
    });

    view.unmount();
    terminalMock.mounts.mockClear();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByTestId("terminal-terminal-1")).toBeTruthy();
    expect(await screen.findByTestId("terminal-terminal-2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Restart terminal" })).toHaveLength(2);
    expect(terminalMock.mounts).not.toHaveBeenCalled();
  });

  it("dispatches close for the terminal leaf without starting a PTY", async () => {
    saveStoppedTerminalLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByTestId("terminal-terminal-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mock terminal close" }));

    await waitFor(() => expect(screen.queryByTestId("terminal-terminal-1")).toBeNull());
    expect(terminalMock.mounts).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pane-primary")).toBeTruthy();
  });
});

describe("WorkspaceShell pane routing", () => {
  it("renders exactly two stable primary/secondary columns with primary initially focused", async () => {
    const { container, rerender } = render(<WorkspaceShell renderPane={renderPane} />);
    const slots = [...container.querySelectorAll<HTMLElement>(".workspace-pane-slot")];

    expect(slots.map((slot) => slot.dataset.paneId)).toEqual(["primary", "secondary"]);
    expect(screen.getByTestId("pane-primary").dataset.kind).toBe("primary");
    expect(screen.getByTestId("pane-secondary").dataset.kind).toBe("auxiliary");
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
    const mounts = { primary: vi.fn(), auxiliary: vi.fn() };
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
    expect(mounts.auxiliary).toHaveBeenCalledTimes(1);
  });

  it("moves focus by pointer, focus, and Ctrl/Cmd+1-4 in visible pane order", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    const paneThree = screen.getByRole("textbox", { name: "pane-1 input" });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(document.activeElement).toBe(paneThree);
    expect(screen.getByTestId("pane-pane-1").dataset.focused).toBe("true");
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

  it("opens the exact focused primary or auxiliary pane without changing its source", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const primary = screen.getByTestId("pane-primary");
    const secondary = screen.getByTestId("pane-secondary");

    const primaryAction = await screen.findByRole("button", { name: "Open in new window" });
    await waitFor(() => expect(primaryAction.hasAttribute("disabled")).toBe(false));
    fireEvent.click(primaryAction);
    await waitFor(() => expect(bridge.openPaneInNewWindow).toHaveBeenCalledWith("primary"));

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    const secondaryAction = screen.getByRole("button", { name: "Open in new window" });
    await waitFor(() => expect(secondaryAction.hasAttribute("disabled")).toBe(false));
    fireEvent.click(secondaryAction);
    await waitFor(() => expect(bridge.openPaneInNewWindow).toHaveBeenNthCalledWith(2, "secondary"));

    expect(screen.getByTestId("pane-primary")).toBe(primary);
    expect(screen.getByTestId("pane-secondary")).toBe(secondary);
    expect(secondary.dataset.focused).toBe("true");
    expect(secondary.dataset.initialCwd).toBe("");
    expect(screen.queryByTestId("terminal-secondary")).toBeNull();
  });

  it("disables the action until a pane has a restored project target", async () => {
    render(<WorkspaceShell renderPane={(props) => <PickerAwarePane {...props} />} />);
    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    await screen.findByTestId("pane-pane-1");

    expect(
      screen.getByRole("button", { name: "Open in new window" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(bridge.openPaneInNewWindow).not.toHaveBeenCalled();
  });

  it("deduplicates pending clicks and restores the action after one native rejection", async () => {
    let rejectOpen: ((error: Error) => void) | undefined;
    bridge.openPaneInNewWindow.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        }),
    );
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = screen.getByTestId("pane-primary");
    const action = screen.getByRole("button", { name: "Open in new window" });
    await waitFor(() => expect(action.hasAttribute("disabled")).toBe(false));

    fireEvent.click(action);
    fireEvent.click(action);
    expect(bridge.openPaneInNewWindow).toHaveBeenCalledTimes(1);
    expect(action.hasAttribute("disabled")).toBe(true);
    await act(async () => rejectOpen?.(new Error("native build failed")));

    await waitFor(() => expect(action.hasAttribute("disabled")).toBe(false));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      "Couldn't open pane in a new window: native build failed",
      "error",
    );
    expect(screen.getByTestId("pane-primary")).toBe(source);
    expect(source.dataset.focused).toBe("true");
  });

  it("calls each native shortcut bridge exactly once", () => {
    render(<WorkspaceShell renderPane={renderPane} />);

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", metaKey: true });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "a", metaKey: true, shiftKey: true });

    expect(bridge.newWindow).toHaveBeenCalledTimes(1);
    expect(bridge.openPaneInNewWindow).not.toHaveBeenCalled();
    expect(bridge.focusWindowByOffset).toHaveBeenNthCalledWith(1, 1);
    expect(bridge.focusWindowByOffset).toHaveBeenNthCalledWith(2, -1);
    expect(bridge.focusWindowByOffset).toHaveBeenCalledTimes(2);
    expect(bridge.arrangeAllWindows).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceShell secondary pane lifecycle", () => {
  it("disposes only secondary listeners/session state and restores primary focus", async () => {
    const disposed = { primary: vi.fn(), auxiliary: vi.fn() };
    function DisposablePane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => () => disposed[props.kind](), [props.kind]);
      return <FakePane {...props} />;
    }

    render(<WorkspaceShell renderPane={(props) => <DisposablePane {...props} />} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => expect(disposed.auxiliary).toHaveBeenCalledTimes(1));
    expect(disposed.primary).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("primary input"),
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    const created = await screen.findByTestId("pane-pane-1");
    expect(created.dataset.kind).toBe("auxiliary");
    expect(screen.getByRole("button", { name: "Close pane-1 pane" })).toBeTruthy();
  });

  it("closes an arbitrary picker pane immediately and disposes exactly its renderPane mount", async () => {
    const disposals = vi.fn();
    function DisposablePane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => () => disposals(props.paneId), [props.paneId]);
      return <FakePane {...props} />;
    }
    render(<WorkspaceShell renderPane={(props) => <DisposablePane {...props} />} />);
    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    await screen.findByTestId("pane-pane-1");
    disposals.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Close pane-1 pane" }));

    await waitFor(() => expect(screen.queryByTestId("pane-pane-1")).toBeNull());
    expect(disposals.mock.calls.filter(([paneId]) => paneId === "pane-1")).toHaveLength(1);
    expect(disposals).not.toHaveBeenCalledWith("secondary");
    expect(screen.getByTestId("pane-primary")).toBeTruthy();
    expect(screen.getByTestId("pane-secondary")).toBeTruthy();
  });

  it("closes generated pane-1 as the sole auxiliary and restores the collapsed primary workspace", async () => {
    const disposals = vi.fn();
    function DisposablePane(props: AgentPaneProps): React.ReactElement {
      useEffect(() => () => disposals(props.paneId), [props.paneId]);
      return <FakePane {...props} />;
    }
    const renderDisposablePane = (props: AgentPaneProps): React.ReactNode => (
      <DisposablePane {...props} />
    );
    const first = render(<WorkspaceShell renderPane={renderDisposablePane} />);

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    await screen.findByTestId("pane-pane-1");
    disposals.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close pane-1 pane" }));

    await waitFor(() => expect(screen.queryByTestId("pane-pane-1")).toBeNull());
    expect(disposals.mock.calls.filter(([paneId]) => paneId === "pane-1")).toHaveLength(1);
    expect(screen.getByTestId("pane-primary").dataset.focused).toBe("true");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("primary input"),
    );
    expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/primary");
    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("gg-workspace-layout-recursive:main") ?? "null",
      );
      expect(saved.root).toEqual({ type: "leaf", paneId: "primary" });
      expect(saved.focusedPaneId).toBe("primary");
      expect(saved.panes["pane-1"]).toBeUndefined();
    });

    first.unmount();
    render(<WorkspaceShell renderPane={renderDisposablePane} />);

    const restoredPrimary = await screen.findByTestId("pane-primary");
    expect(restoredPrimary.dataset.focused).toBe("true");
    expect(screen.queryByTestId("pane-pane-1")).toBeNull();
    expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("notes").dataset.cwd).toBe("/work/primary"));
    expect(disposals.mock.calls.filter(([paneId]) => paneId === "pane-1")).toHaveLength(1);
  });

  it("does not resurrect or reuse a pane ID after rapid split-close and a late snapshot", async () => {
    let emitLateSnapshot: (() => void) | undefined;
    function LatePane({ onSnapshot, paneId }: AgentPaneProps): React.ReactElement {
      useEffect(() => {
        const emit = () =>
          onSnapshot({
            paneId,
            cwd: `/work/${paneId}`,
            sessionPath: null,
            sessionTitle: paneId,
            projectBound: true,
            restoreChecked: true,
            activeWork: false,
          });
        emit();
        if (paneId === "pane-1") emitLateSnapshot = emit;
      }, [onSnapshot, paneId]);
      return <div data-testid={`late-${paneId}`} />;
    }

    render(<WorkspaceShell renderPane={(props) => <LatePane {...props} />} />);
    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    await screen.findByTestId("late-pane-1");
    fireEvent.click(screen.getByRole("button", { name: "Close pane-1 pane" }));
    await waitFor(() => expect(screen.queryByTestId("late-pane-1")).toBeNull());

    act(() => emitLateSnapshot?.());
    fireEvent.click(screen.getByRole("button", { name: "Split Down" }));
    expect(await screen.findByTestId("late-pane-2")).toBeTruthy();
    expect(screen.queryByTestId("late-pane-1")).toBeNull();
    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("gg-workspace-layout-recursive:main") ?? "null",
      );
      expect(saved.panes["pane-1"]).toBeUndefined();
      expect(saved.panes["pane-2"]).toBeTruthy();
    });
  });

  it("requires confirmation before closing an active pane and keeps it on cancel", async () => {
    function ConfirmPane({ onSnapshot, paneId }: AgentPaneProps): React.ReactElement {
      useEffect(() => {
        onSnapshot({
          paneId,
          cwd: `/work/${paneId}`,
          sessionPath: `/sessions/${paneId}.jsonl`,
          sessionTitle: paneId,
          projectBound: true,
          restoreChecked: true,
          activeWork: paneId === "pane-1",
        });
      }, [onSnapshot, paneId]);
      return <div data-testid={`active-${paneId}`} />;
    }

    render(<WorkspaceShell renderPane={(props) => <ConfirmPane {...props} />} />);
    fireEvent.click(screen.getByRole("button", { name: "Split Down" }));
    await screen.findByTestId("active-pane-1");
    fireEvent.click(screen.getByRole("button", { name: "Close pane-1 pane" }));

    expect(
      screen.getByText(
        "Work is active in this pane. Closing it will stop that session. Close anyway?",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("active-pane-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close pane-1 pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));
    await waitFor(() => expect(screen.queryByTestId("active-pane-1")).toBeNull());
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
        7,
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
        7,
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

    const divider = await screen.findByRole("separator", {
      name: "Resize horizontal workspace panes",
    });
    await waitFor(() =>
      expect(screen.getByTestId("pane-primary").dataset.initialCwd).toBe("/saved/a"),
    );
    expect(screen.getByTestId("pane-secondary").dataset.initialSession).toBe("/sessions/b.jsonl");
    expect(divider.getAttribute("aria-valuenow")).toBe("64");
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
  it("resizes recursive horizontal and vertical splits independently and restores both ratios", async () => {
    const storageKey = "gg-workspace-layout-recursive:main";
    const first = render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.pointerDown(screen.getByTestId("pane-primary"));
    fireEvent.click(screen.getByRole("button", { name: "Split Down" }));
    await screen.findByTestId("pane-pane-1");

    const horizontal = screen.getByRole("separator", { name: "Resize horizontal workspace panes" });
    const vertical = screen.getByRole("separator", { name: "Resize vertical workspace panes" });
    vi.spyOn(horizontal.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1009,
      height: 700,
      top: 0,
      right: 1009,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(vertical.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 500,
      height: 709,
      top: 0,
      right: 500,
      bottom: 709,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.keyDown(horizontal, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(vertical, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => {
      const root = JSON.parse(localStorage.getItem(storageKey)!).root;
      expect(root.size.value).toBeCloseTo(59.6, 1);
      expect(root.first.size.value).toBe(60);
    });
    first.unmount();

    render(<WorkspaceShell renderPane={renderPane} />);
    expect(
      (await screen.findByRole("separator", { name: "Resize horizontal workspace panes" }))
        .parentElement?.dataset.splitRatio,
    ).toBe("59.6");
    expect(
      screen.getByRole("separator", { name: "Resize vertical workspace panes" }).parentElement
        ?.dataset.splitRatio,
    ).toBe("60");
  });

  it("caps rapid split mutations at four leaves", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    }

    await waitFor(() => expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(4));
    expect(screen.queryByTestId("pane-pane-3")).toBeNull();
  });

  it("disables both split actions at the four-leaf cap", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    await screen.findByTestId("pane-pane-1");
    fireEvent.click(screen.getByRole("button", { name: "Split Down" }));
    await screen.findByTestId("pane-pane-2");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Right" }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Down" }).disabled).toBe(
      true,
    );
    expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(4);
  });
  it("applies pointer drag deltas relative to the available pane width", () => {
    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize horizontal workspace panes" });
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1009,
      height: 700,
      top: 0,
      right: 1009,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 600, pointerId: 7 });

    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
  });

  it("clamps pointer resizing to a 280px minimum for each pane", () => {
    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize horizontal workspace panes" });
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1009,
      height: 700,
      top: 0,
      right: 1009,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 8 });
    fireEvent.pointerMove(window, { clientX: -5_000, pointerId: 8 });
    expect(divider.getAttribute("aria-valuenow")).toBe("28");

    fireEvent.pointerMove(window, { clientX: 5_000, pointerId: 8 });
    expect(divider.getAttribute("aria-valuenow")).toBe("72");
  });

  it("supports arrow, accelerated arrow, Home, and End keyboard controls", () => {
    const { container } = render(<WorkspaceShell renderPane={renderPane} />);
    setWorkspaceWidth(container, 1009);
    const divider = screen.getByRole("separator", { name: "Resize horizontal workspace panes" });
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1009,
      height: 700,
      top: 0,
      right: 1009,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

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
    const divider = screen.getByRole("separator", { name: "Resize horizontal workspace panes" });
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1009,
      height: 700,
      top: 0,
      right: 1009,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
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
