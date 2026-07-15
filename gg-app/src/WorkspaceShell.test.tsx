// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps } from "./AgentPane";
import { WorkspaceShell } from "./WorkspaceShell";

const bridge = vi.hoisted(() => ({
  disposePaneSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("./agent", () => ({
  disposePaneSession: bridge.disposePaneSession,
  windowLabel: "main",
}));
vi.mock("./AgentPane", () => ({ AgentPane: () => null }));

function FakePane(props: AgentPaneProps): React.ReactElement {
  const { initialTarget, onSnapshot, paneId = "primary", registerInput } = props;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    registerInput?.(paneId, {
      focus: () => input.current?.focus(),
      handleNativeDrop: () => undefined,
    });
    onSnapshot?.({
      paneId,
      mode: initialTarget?.mode ?? "code",
      chatAgent: initialTarget?.chatAgent,
      cwd: initialTarget?.cwd ?? null,
      sessionPath: initialTarget?.sessionPath ?? null,
      sessionTitle: initialTarget?.cwd ?? null,
      projectBound: initialTarget !== null,
      restoreChecked: true,
      activeWork: false,
    });
    return () => registerInput?.(paneId, null);
  }, [initialTarget, onSnapshot, paneId, registerInput]);
  return (
    <div
      data-testid={`pane-${paneId}`}
      data-focused={String(props.focused)}
      data-target={props.initialTarget?.cwd ?? "picker"}
    >
      <input ref={input} aria-label={`${props.paneId} input`} />
    </div>
  );
}

const renderPane = (props: AgentPaneProps): React.ReactNode => <FakePane {...props} />;

function saveTwoPaneLayout(): void {
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
      focusedPaneId: "primary",
      panes: {
        primary: { kind: "agent", mode: "code", cwd: "/one", sessionPath: "/one.jsonl" },
        secondary: { kind: "agent", mode: "code", cwd: "/two", sessionPath: "/two.jsonl" },
      },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceShell", () => {
  it("renders the agent-only workspace and splits right or down", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    expect(await screen.findByTestId("pane-primary")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    expect(await screen.findByTestId("pane-pane-1")).toBeTruthy();
    expect(document.querySelector(".workspace-split-horizontal")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split Down" }));
    expect(await screen.findByTestId("pane-pane-2")).toBeTruthy();
    expect(document.querySelector(".workspace-split-vertical")).toBeTruthy();
  });

  it("restores pane targets and persists canonical focus", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect((await screen.findByTestId("pane-primary")).dataset.target).toBe("/one");
    expect(screen.getByTestId("pane-secondary").dataset.target).toBe("/two");
    fireEvent.pointerDown(screen.getByTestId("pane-secondary"));
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.focusedPaneId).toBe("secondary");
      expect(saved.panes.secondary.sessionPath).toBe("/two.jsonl");
    });
  });

  it("resizes with pointer and keyboard and persists the ratio", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const divider = await screen.findByRole("separator");
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 700,
    } as DOMRect);

    fireEvent.pointerDown(divider, { button: 0, clientX: 500, pointerId: 4 });
    fireEvent.pointerMove(window, { clientX: 600, pointerId: 4 });
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
    fireEvent.pointerUp(window, { pointerId: 4 });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("55");

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.size.value).toBe(55);
    });
  });

  it("closes an auxiliary session, collapses the tree, and restores focus", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());
    expect(bridge.disposePaneSession).toHaveBeenCalledWith("secondary");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root).toEqual({ type: "leaf", paneId: "primary" });
      expect(saved.panes.secondary).toBeUndefined();
    });
  });
});
