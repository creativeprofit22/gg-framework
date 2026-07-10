// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps } from "./AgentPane";
import { WorkspaceShell } from "./WorkspaceShell";

const bridge = vi.hoisted(() => ({
  arrangeAllWindows: vi.fn(() => Promise.resolve()),
  focusWindowByOffset: vi.fn(() => Promise.resolve()),
  newWindow: vi.fn(() => Promise.resolve()),
  onWindowOrder: vi.fn(() => Promise.resolve(() => undefined)),
  setWindowTitle: vi.fn(),
  onDragDropEvent: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: bridge.onDragDropEvent }),
}));
vi.mock("./agent", () => ({
  arrangeAllWindows: bridge.arrangeAllWindows,
  focusWindowByOffset: bridge.focusWindowByOffset,
  newWindow: bridge.newWindow,
  onWindowOrder: bridge.onWindowOrder,
  setWindowTitle: bridge.setWindowTitle,
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

function FakePane({
  paneId,
  kind,
  focused,
  onFocus,
  onSnapshot,
  registerInput,
}: AgentPaneProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    registerInput(paneId, {
      focus: () => inputRef.current?.focus(),
      handleNativeDrop: () => undefined,
    });
    onSnapshot({
      paneId,
      cwd: `/work/${paneId}`,
      sessionTitle: paneId,
      projectBound: true,
    });
    return () => registerInput(paneId, null);
  }, [onSnapshot, paneId, registerInput]);

  return (
    <div
      data-testid={`pane-${paneId}`}
      data-kind={kind}
      data-focused={String(focused)}
      onPointerDown={() => onFocus(paneId)}
      onFocusCapture={() => onFocus(paneId)}
    >
      <input ref={inputRef} aria-label={`${paneId} input`} />
    </div>
  );
}

const renderPane = (props: AgentPaneProps): React.ReactNode => <FakePane {...props} />;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

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
