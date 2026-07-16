// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps } from "./AgentPane";
import { WorkspaceShell } from "./WorkspaceShell";

const bridge = vi.hoisted(() => ({
  copiedPaneRestoreTarget: vi.fn(() =>
    Promise.resolve(
      null as null | {
        mode: "code" | "chat";
        chatAgent?: "general" | "therapist" | "research";
        cwd: string;
        sessionPath: string | null;
      },
    ),
  ),
  copyPaneToNewWindow: vi.fn(() =>
    Promise.resolve({ windowLabel: "project-1", reusedWindow: false }),
  ),
  disposePaneSession: vi.fn(() => Promise.resolve()),
}));
const paneMounts = new Map<string, number>();
const paneUnmounts = new Map<string, number>();

vi.mock("./agent", () => ({
  copiedPaneRestoreTarget: bridge.copiedPaneRestoreTarget,
  copyPaneToNewWindow: bridge.copyPaneToNewWindow,
  disposePaneSession: bridge.disposePaneSession,
  windowLabel: "main",
}));
vi.mock("./AgentPane", () => ({ AgentPane: () => null }));

function FakePane(props: AgentPaneProps): React.ReactElement {
  const { initialTarget, onSnapshot, paneId = "primary", registerInput } = props;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    paneMounts.set(paneId, (paneMounts.get(paneId) ?? 0) + 1);
    return () => {
      paneUnmounts.set(paneId, (paneUnmounts.get(paneId) ?? 0) + 1);
    };
  }, [paneId]);
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

function dragTransfer(types = ["application/x-gg-workspace-pane"]): DataTransfer {
  return {
    types,
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    getData: vi.fn(),
  } as unknown as DataTransfer;
}

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

function saveFourPaneLayout(): void {
  localStorage.setItem(
    "gg-workspace-layout-recursive:main",
    JSON.stringify({
      version: 9,
      root: {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 55 },
        first: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 60 },
          first: { type: "leaf", paneId: "primary" },
          second: { type: "leaf", paneId: "pane-1" },
        },
        second: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 40 },
          first: { type: "leaf", paneId: "pane-2" },
          second: { type: "leaf", paneId: "pane-3" },
        },
      },
      focusedPaneId: "primary",
      panes: {
        primary: { kind: "agent", mode: "code", cwd: "/primary", sessionPath: "/p.jsonl" },
        "pane-1": { kind: "agent", mode: "code", cwd: "/one", sessionPath: "/1.jsonl" },
        "pane-2": {
          kind: "agent",
          mode: "chat",
          chatAgent: "research",
          cwd: "/two",
          sessionPath: "/2.jsonl",
        },
        "pane-3": { kind: "agent", mode: "code", cwd: "/three", sessionPath: "/3.jsonl" },
      },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  paneMounts.clear();
  paneUnmounts.clear();
  bridge.copiedPaneRestoreTarget.mockReset().mockResolvedValue(null);
  bridge.copyPaneToNewWindow
    .mockReset()
    .mockResolvedValue({ windowLabel: "project-1", reusedWindow: false });
  bridge.disposePaneSession.mockReset().mockResolvedValue(undefined);
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
    await waitFor(() =>
      expect(localStorage.getItem("gg-workspace-layout-recursive:main")).not.toBeNull(),
    );

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

  it("copies only the focused pane to a new window and preserves the source", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await screen.findByTestId("pane-secondary");

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    await waitFor(() => expect(source.dataset.focused).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Copy to New Window" }));

    await waitFor(() => expect(bridge.copyPaneToNewWindow).toHaveBeenCalledWith("secondary"));
    expect(screen.getByTestId("pane-secondary")).toBe(source);
    expect(screen.getByTestId("pane-primary")).toBeTruthy();
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    expect(screen.getByText("Pane secondary copied to window project-1.")).toBeTruthy();
  });

  it("reports copy failure with successful rollback and keeps the focused source", async () => {
    saveTwoPaneLayout();
    bridge.copyPaneToNewWindow.mockRejectedValueOnce({ rollbackSucceeded: true });
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await screen.findByTestId("pane-secondary");

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    await waitFor(() => expect(source.dataset.focused).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Copy to New Window" }));

    expect(
      await screen.findByText("Could not copy pane secondary; the new window was rolled back."),
    ).toBeTruthy();
    expect(screen.getByTestId("pane-secondary")).toBe(source);
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
  });

  it("reports a reused destination window without altering the focused source", async () => {
    saveTwoPaneLayout();
    bridge.copyPaneToNewWindow.mockResolvedValueOnce({
      windowLabel: "project-4",
      reusedWindow: true,
    });
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await screen.findByTestId("pane-secondary");

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    await waitFor(() => expect(source.dataset.focused).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Copy to New Window" }));

    expect(
      await screen.findByText("Pane secondary is already copied in window project-4."),
    ).toBeTruthy();
    expect(screen.getByTestId("pane-secondary")).toBe(source);
  });

  it("hydrates a copied window as exactly one primary pane", async () => {
    bridge.copiedPaneRestoreTarget.mockResolvedValueOnce({
      mode: "chat",
      chatAgent: "research",
      cwd: "/copied",
      sessionPath: "/copied/session.jsonl",
    });
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect((await screen.findByTestId("pane-primary")).dataset.target).toBe("/copied");
    expect(screen.queryByTestId("pane-secondary")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("opts into accessible pane drag controls and moves without remounting or disposing", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const secondaryPane = await screen.findByTestId("pane-secondary");
    expect(screen.queryByRole("button", { name: "Move pane secondary" })).toBeNull();

    const toggle = screen.getByRole("button", { name: "Rearrange panes" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    const handle = screen.getByRole("button", { name: "Move pane secondary" });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(handle, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-gg-workspace-pane",
      "secondary",
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "secondary");
    expect(dataTransfer.effectAllowed).toBe("move");
    const leftZone = document.querySelector('[data-pane-id="primary"] [data-placement="left"]')!;
    fireEvent.dragOver(leftZone, { dataTransfer });
    expect(
      document
        .querySelector('[data-pane-id="primary"] .pane-drop-overlay')
        ?.getAttribute("data-hovered-placement"),
    ).toBe("left");
    fireEvent.drop(leftZone, { dataTransfer });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.first).toEqual({ type: "leaf", paneId: "secondary" });
      expect(saved.focusedPaneId).toBe("secondary");
    });
    expect(screen.getByTestId("pane-secondary")).toBe(secondaryPane);
    expect(paneMounts.get("secondary")).toBe(1);
    expect(paneUnmounts.get("secondary") ?? 0).toBe(0);
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    expect(screen.getByText("Pane secondary moved left of primary.")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Move pane secondary" }),
    );
  });

  it("preserves every pane host across a nested cross-parent move", async () => {
    saveFourPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const paneIds = ["primary", "pane-1", "pane-2", "pane-3"];
    const paneNodes = new Map(
      await Promise.all(
        paneIds.map(
          async (paneId) => [paneId, await screen.findByTestId(`pane-${paneId}`)] as const,
        ),
      ),
    );
    const movedPaneInput = screen.getByRole("textbox", {
      name: "pane-1 input",
    }) as HTMLInputElement;
    fireEvent.change(movedPaneInput, { target: { value: "draft survives move" } });

    fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
    const movedHandle = screen.getByRole("button", { name: "Move pane pane-1" });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(movedHandle, { dataTransfer });
    const downZone = document.querySelector('[data-pane-id="pane-3"] [data-placement="down"]')!;
    fireEvent.dragOver(downZone, { dataTransfer });
    fireEvent.drop(downZone, { dataTransfer });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root).toEqual({
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 55 },
        first: { type: "leaf", paneId: "primary" },
        second: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 40 },
          first: { type: "leaf", paneId: "pane-2" },
          second: {
            type: "split",
            direction: "vertical",
            size: { type: "ratio", value: 50 },
            first: { type: "leaf", paneId: "pane-3" },
            second: { type: "leaf", paneId: "pane-1" },
          },
        },
      });
      expect(saved.focusedPaneId).toBe("pane-1");
      expect(saved.panes).toEqual({
        primary: { kind: "agent", mode: "code", cwd: "/primary", sessionPath: "/p.jsonl" },
        "pane-1": { kind: "agent", mode: "code", cwd: "/one", sessionPath: "/1.jsonl" },
        "pane-2": {
          kind: "agent",
          mode: "chat",
          chatAgent: "research",
          cwd: "/two",
          sessionPath: "/2.jsonl",
        },
        "pane-3": { kind: "agent", mode: "code", cwd: "/three", sessionPath: "/3.jsonl" },
      });
    });

    for (const paneId of paneIds) {
      expect(screen.getByTestId(`pane-${paneId}`)).toBe(paneNodes.get(paneId));
      expect(paneMounts.get(paneId)).toBe(1);
      expect(paneUnmounts.get(paneId) ?? 0).toBe(0);
    }
    expect(screen.getByRole("textbox", { name: "pane-1 input" })).toBe(movedPaneInput);
    expect(movedPaneInput.value).toBe("draft survives move");
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move pane pane-1" }));
  });

  it.each(["Escape", "pointercancel", "dragend", "blur", "outside drop"])(
    "cancels pane dragging through %s without changing the layout",
    async (path) => {
      saveTwoPaneLayout();
      render(<WorkspaceShell renderPane={renderPane} />);
      await screen.findByTestId("pane-secondary");
      fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
      const handle = screen.getByRole("button", { name: "Move pane secondary" });
      const dataTransfer = dragTransfer();
      fireEvent.dragStart(handle, { dataTransfer });

      if (path === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (path === "pointercancel") fireEvent.pointerCancel(window);
      else if (path === "dragend") fireEvent.dragEnd(handle, { dataTransfer });
      else if (path === "blur") fireEvent.blur(window);
      else fireEvent.drop(window, { dataTransfer });

      await waitFor(() => expect(document.querySelector(".pane-drag-active")).toBeNull());
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.first.paneId).toBe("primary");
      expect(saved.root.second.paneId).toBe("secondary");
      expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    },
  );

  it("focuses visible panes with Ctrl/Cmd+1..4 shortcuts", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "secondary input" }));
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
  });

  it("keeps split, close, divider, and rearrangement controls discoverable by role and name", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");

    expect(screen.getByRole("button", { name: "Split Right" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Split Down" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close secondary pane" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rearrange panes" })).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "Resize horizontal workspace panes" }),
    ).toBeTruthy();
    expect(screen.getByRole("separator").getAttribute("aria-controls")).toBe(
      "workspace-pane-primary workspace-pane-secondary",
    );
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
