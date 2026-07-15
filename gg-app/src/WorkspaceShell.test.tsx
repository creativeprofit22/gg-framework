// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps } from "./AgentPane";
import { WorkspaceShell } from "./WorkspaceShell";

const toastMock = vi.hoisted(() => vi.fn(() => 1));
const bridge = vi.hoisted(() => ({
  arrangeAllWindows: vi.fn(() => Promise.resolve()),
  disposePaneSession: vi.fn(() => Promise.resolve()),
  focusWindowByOffset: vi.fn(() => Promise.resolve()),
  newWindow: vi.fn(() => Promise.resolve()),
  openPaneInNewWindow: vi.fn(() => Promise.resolve()),
  onWindowOrder: vi.fn(() => Promise.resolve(() => undefined)),
  setWindowTitle: vi.fn(),
  validateWorkspaceTarget: vi.fn(() =>
    Promise.resolve({ projectExists: true, sessionExists: true }),
  ),
  nativeDropListener: undefined as
    | ((event: { payload: { type: string; paths: string[] } }) => void)
    | undefined,
}));

vi.mock("./AgentPane", () => ({ AgentPane: () => null }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(
      (listener: (event: { payload: { type: string; paths: string[] } }) => void) => {
        bridge.nativeDropListener = listener;
        return Promise.resolve(() => undefined);
      },
    ),
  }),
}));
vi.mock("./agent", () => ({
  arrangeAllWindows: bridge.arrangeAllWindows,
  disposePaneSession: bridge.disposePaneSession,
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
  useProgress: () => ({
    snapshot: null,
    levelUp: null,
    levelUpNonce: null,
    levelUpOrigin: false,
  }),
}));
vi.mock("./ProjectNotes", () => ({
  ProjectNotes: ({ cwd }: { cwd: string | null }) => (
    <div data-testid="notes" data-cwd={cwd ?? ""} />
  ),
}));
vi.mock("./Confetti", () => ({ Confetti: () => null }));
vi.mock("./Toaster", () => ({ Toaster: () => null }));
vi.mock("./toast", () => ({ toast: toastMock }));

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
      handleNativeDrop: (paths) => nativeDrops(paneId, paths),
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
      onPointerDown={() => onFocus(paneId)}
      onFocusCapture={() => onFocus(paneId)}
    >
      <input ref={inputRef} aria-label={`${paneId} input`} />
    </div>
  );
}

const renderPane = (props: AgentPaneProps): React.ReactNode => <FakePane {...props} />;
const nativeDrops = vi.fn();

function saveAgentLayout(focusedPaneId = "primary"): void {
  localStorage.setItem(
    "gg-workspace-layout-recursive:main",
    JSON.stringify({
      version: 9,
      root: {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 50 },
        first: { type: "leaf", paneId: "primary" },
        second: { type: "leaf", paneId: "secondary" },
      },
      focusedPaneId,
      panes: {
        primary: { kind: "agent", cwd: "/saved/primary", sessionPath: "/sessions/primary.jsonl" },
        secondary: {
          kind: "agent",
          cwd: "/saved/secondary",
          sessionPath: "/sessions/secondary.jsonl",
        },
      },
    }),
  );
}

function dragTransfer(types = ["application/x-gg-workspace-pane"]): DataTransfer {
  return {
    types,
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    getData: vi.fn(),
  } as unknown as DataTransfer;
}

function rect(width: number, height = 700): DOMRect {
  return {
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function saveV8MixedLayout(focusedPaneId = "terminal-1"): void {
  localStorage.setItem(
    "gg-workspace-layout-recursive:main",
    JSON.stringify({
      version: 8,
      root: {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 40 },
        first: { type: "leaf", paneId: "primary" },
        second: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 60 },
          first: { type: "leaf", paneId: "secondary" },
          second: { type: "leaf", paneId: "terminal-1" },
        },
      },
      focusedPaneId,
      defaultTerminalBootstrap: "complete",
      panes: {
        primary: { kind: "agent", cwd: "/saved/primary", sessionPath: null },
        secondary: { kind: "agent", cwd: "/saved/secondary", sessionPath: null },
        "terminal-1": {
          kind: "terminal",
          stopped: true,
          cwd: "/saved/primary",
          sessionPath: null,
        },
      },
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.clearAllMocks();
  bridge.nativeDropListener = undefined;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceShell agent workspace", () => {
  it("renders an agent-only primary workspace with no terminal affordance", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByTestId("pane-primary")).toBeTruthy();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(document.querySelector(".terminal-pane")).toBeNull();
  });

  it.each([
    ["Split Right", "horizontal"],
    ["Split Down", "vertical"],
  ])("%s creates one focused auxiliary agent pane", async (action, direction) => {
    render(<WorkspaceShell renderPane={renderPane} />);
    fireEvent.click(await screen.findByRole("button", { name: action }));

    const created = await screen.findByTestId("pane-pane-1");
    expect(created.dataset.kind).toBe("auxiliary");
    expect(created.dataset.focused).toBe("true");
    expect(created.dataset.initialMode).toBe("picker");
    expect(document.querySelector(`.workspace-split-${direction}`)).toBeTruthy();
  });

  it("limits splitting by the agent pane capacity", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    for (let index = 1; index < 12; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
      await screen.findByTestId(`pane-pane-${index}`);
    }

    expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(12);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Right" }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Split Down" }).disabled).toBe(
      true,
    );
  });

  it("opens the focused agent pane in a new native window", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    const action = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Open in new window",
    });
    await waitFor(() => expect(action.disabled).toBe(false));

    fireEvent.click(action);

    await waitFor(() => expect(bridge.openPaneInNewWindow).toHaveBeenCalledWith("primary"));
  });

  it("commits an actual agent drag/drop move and persists canonical identity", async () => {
    saveAgentLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
    const handle = screen.getByRole("button", { name: "Move pane secondary" });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.drop(document.querySelector('[data-pane-id="primary"] [data-placement="left"]')!, {
      dataTransfer,
    });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.first).toEqual({ type: "leaf", paneId: "secondary" });
      expect(saved.focusedPaneId).toBe("secondary");
      expect(saved.panes.secondary).toEqual({
        kind: "agent",
        cwd: "/work/secondary",
        sessionPath: "/sessions/secondary.jsonl",
      });
      expect(Object.keys(saved)).toEqual(["version", "root", "focusedPaneId", "panes"]);
    });
    expect(screen.getByText("Pane secondary moved left of primary.")).toBeTruthy();
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
  });

  it.each(["Escape", "pointercancel", "dragend", "blur"])(
    "cancels an agent move through %s without changing layout",
    async (path) => {
      saveAgentLayout();
      render(<WorkspaceShell renderPane={renderPane} />);
      await screen.findByTestId("pane-secondary");
      fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
      const handle = screen.getByRole("button", { name: "Move pane secondary" });
      const dataTransfer = dragTransfer();
      fireEvent.dragStart(handle, { dataTransfer });
      if (path === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (path === "pointercancel") fireEvent.pointerCancel(window);
      else if (path === "dragend") fireEvent.dragEnd(handle, { dataTransfer });
      else fireEvent.blur(window);

      await waitFor(() => expect(document.querySelector(".pane-drag-active")).toBeNull());
      expect(screen.getByText("Pane move cancelled.")).toBeTruthy();
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.first.paneId).toBe("primary");
      expect(saved.root.second.paneId).toBe("secondary");
    },
  );

  it("resizes agent panes by pointer and keyboard and persists the ratio", async () => {
    saveAgentLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const divider = await screen.findByRole("separator");
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue(rect(1009));
    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 600, pointerId: 7 });
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
    fireEvent.pointerUp(window, { pointerId: 7 });
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(divider.getAttribute("aria-valuenow")).toBe("70");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(divider.getAttribute("aria-valuenow")).toBe("28");
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.size.value).toBeCloseTo(28, 0);
    });
  });

  it("routes pane focus and pane/native keyboard shortcuts", async () => {
    saveAgentLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    fireEvent.pointerDown(screen.getByTestId("pane-secondary"));
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", metaKey: true });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "a", metaKey: true, shiftKey: true });
    expect(bridge.newWindow).toHaveBeenCalledTimes(1);
    expect(bridge.focusWindowByOffset).toHaveBeenNthCalledWith(1, 1);
    expect(bridge.focusWindowByOffset).toHaveBeenNthCalledWith(2, -1);
    expect(bridge.arrangeAllWindows).toHaveBeenCalledTimes(1);
  });

  it("recovers stale agent targets and saves the canonical picker fallback", async () => {
    saveAgentLayout();
    bridge.validateWorkspaceTarget.mockImplementation(async (...args: unknown[]) => ({
      projectExists: args[0] !== "/saved/secondary",
      sessionExists: true,
    }));
    render(<WorkspaceShell renderPane={renderPane} />);
    const secondary = await screen.findByTestId("pane-secondary");
    expect(secondary.dataset.initialMode).toBe("picker");
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        "Some saved workspace panes were unavailable. A safe layout was restored.",
        "warning",
        4000,
        false,
      ),
    );
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.panes.secondary).toBeNull();
    });
  });

  it("routes native file drops to the focused agent pane", async () => {
    saveAgentLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitFor(() => expect(bridge.nativeDropListener).toBeTypeOf("function"));
    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    act(() => bridge.nativeDropListener?.({ payload: { type: "drop", paths: ["/tmp/a.txt"] } }));
    expect(nativeDrops).toHaveBeenCalledWith("secondary", ["/tmp/a.txt"]);
    const transfer = dragTransfer(["Files"]);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes, collapses, disposes an auxiliary agent, and restores primary focus", async () => {
    saveAgentLayout("secondary");
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());
    expect(bridge.disposePaneSession).toHaveBeenCalledWith("secondary");
    expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" })),
    );
    const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
    expect(saved.root).toEqual({ type: "leaf", paneId: "primary" });
    expect(saved.panes.secondary).toBeUndefined();
  });

  it("requires confirmation before disposing an agent with active work", async () => {
    function ActivePane({ paneId, onSnapshot }: AgentPaneProps): React.ReactElement {
      const [reported, setReported] = useState(false);
      useEffect(() => {
        onSnapshot({
          paneId,
          cwd: `/work/${paneId}`,
          sessionPath: null,
          sessionTitle: paneId,
          projectBound: true,
          restoreChecked: true,
          activeWork: paneId === "secondary",
        });
        setReported(true);
      }, [onSnapshot, paneId]);
      return <div data-testid={`active-${paneId}`} data-reported={String(reported)} />;
    }
    saveAgentLayout();
    render(<WorkspaceShell renderPane={(props) => <ActivePane {...props} />} />);
    const activeSecondary = await screen.findByTestId("active-secondary");
    await waitFor(() => expect(activeSecondary.dataset.reported).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    expect(screen.getByText(/Work is active in this pane/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));
    await waitFor(() => expect(screen.queryByTestId("active-secondary")).toBeNull());
    expect(bridge.disposePaneSession).toHaveBeenCalledWith("secondary");
  });

  it("deduplicates a pending native-window copy and recovers from failure", async () => {
    let rejectOpen: ((error: Error) => void) | undefined;
    bridge.openPaneInNewWindow.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectOpen = reject;
        }),
    );
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await screen.findByTestId("pane-primary");
    const action = screen.getByRole<HTMLButtonElement>("button", { name: "Open in new window" });
    await waitFor(() => expect(action.disabled).toBe(false));
    fireEvent.click(action);
    fireEvent.click(action);
    expect(bridge.openPaneInNewWindow).toHaveBeenCalledTimes(1);
    expect(action.disabled).toBe(true);
    await act(async () => rejectOpen?.(new Error("native build failed")));
    await waitFor(() => expect(action.disabled).toBe(false));
    expect(toastMock).toHaveBeenCalledWith(
      "Couldn't open pane in a new window: native build failed",
      "error",
    );
    expect(screen.getByTestId("pane-primary")).toBe(source);
  });
});

describe("WorkspaceShell v9 terminal migration", () => {
  it("prunes v8 terminal leaves, collapses their split, and focuses primary", async () => {
    saveV8MixedLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByTestId("pane-primary")).toBeTruthy();
    expect(await screen.findByTestId("pane-secondary")).toBeTruthy();
    expect(screen.getByTestId("pane-primary").dataset.focused).toBe("true");
    expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(2);
    expect(document.querySelector(".terminal-pane")).toBeNull();

    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("gg-workspace-layout-recursive:main") ?? "null",
      ) as {
        version: number;
        focusedPaneId: string;
        panes: Record<string, unknown>;
        defaultTerminalBootstrap?: unknown;
      };
      expect(saved.version).toBe(9);
      expect(saved.focusedPaneId).toBe("primary");
      expect(saved.panes).not.toHaveProperty("terminal-1");
      expect(saved).not.toHaveProperty("defaultTerminalBootstrap");
    });
  });

  it("falls back to a fresh primary agent when v8 contains only a terminal", async () => {
    localStorage.setItem(
      "gg-workspace-layout-recursive:main",
      JSON.stringify({
        version: 8,
        root: { type: "leaf", paneId: "terminal-1" },
        focusedPaneId: "terminal-1",
        defaultTerminalBootstrap: "complete",
        panes: {
          "terminal-1": {
            kind: "terminal",
            stopped: true,
            cwd: "/saved/project",
            sessionPath: "/saved/session.jsonl",
          },
        },
      }),
    );
    render(<WorkspaceShell renderPane={renderPane} />);

    const primary = await screen.findByTestId("pane-primary");
    expect(primary.dataset.initialMode).toBe("picker");
    expect(document.querySelectorAll(".workspace-pane-slot")).toHaveLength(1);
    expect(document.querySelector(".terminal-pane")).toBeNull();
  });
});
