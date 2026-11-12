import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { findSwapRow, workspacePaneRects, type WorkspaceSize } from "./workspace-swaps";
import type { WorkspaceLayout, WorkspaceLayoutNode } from "./workspace-layout";
import type { PaneSwapViewState } from "./usePaneSwapViewState";

export const PANE_SWAP_HELP_ID = "pane-swap-instructions";
export const PANE_SWAP_CLOSING_REASON = "Swap unavailable while a pane is closing.";
const modalSelector =
  '.modal-backdrop, .menu-backdrop, .slash-menu, .dropdown-menu, .bgtasks-menu, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
interface Options {
  layout: WorkspaceLayout;
  layoutRef: RefObject<WorkspaceLayout>;
  gridRef: RefObject<HTMLDivElement | null>;
  closingPaneIdsRef: RefObject<ReadonlySet<string>>;
  commit: (side: string, middle: string, size: WorkspaceSize) => WorkspaceLayout | null;
  focusPane: (id: string) => void;
  label: (id: string) => string;
}
interface Pending {
  generation: number;
  side: string;
  middle: string;
  targetKey: string;
  focusId: string;
  origin: string;
  active: Element | null;
  handoff: boolean;
  keyboard: boolean;
  restores: (() => void)[];
  root: WorkspaceLayoutNode;
  before: Map<string, DOMRect>;
}
export function useWorkspacePaneSwaps({
  layout,
  layoutRef,
  gridRef,
  closingPaneIdsRef,
  commit,
  focusPane,
  label,
}: Options) {
  const [size, setSize] = useState<WorkspaceSize>({ width: 0, height: 0 });
  const [announcement, setAnnouncement] = useState("");
  const hosts = useRef(new Map<string, HTMLElement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const views = useRef(new Map<string, PaneSwapViewState>());
  const pending = useRef<Pending | null>(null);
  const generation = useRef(0);
  const focusRoot = useRef<WorkspaceLayoutNode | null>(null);
  const animations = useRef(new Map<string, Animation>());
  const keyboardFocusTarget = useRef<HTMLElement | null>(null);
  const clearKeyboardFocus = useCallback(() => {
    keyboardFocusTarget.current?.removeAttribute("data-swap-keyboard-focus");
    keyboardFocusTarget.current = null;
  }, []);
  const cancelAnimations = useCallback(() => {
    for (const effect of animations.current.values()) {
      effect.onfinish = null;
      effect.cancel();
    }
    animations.current.clear();
  }, []);
  const registerHost = useCallback((id: string, el: HTMLElement | null) => {
    if (el) hosts.current.set(id, el);
    else hosts.current.delete(id);
  }, []);
  const registerButton = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(id, el);
    else buttons.current.delete(id);
  }, []);
  const registerViewState = useCallback((id: string, state: PaneSwapViewState | null) => {
    if (state) views.current.set(id, state);
    else views.current.delete(id);
  }, []);
  const preserveFocus = useCallback(
    () =>
      focusRoot.current === layoutRef.current.root ||
      [...buttons.current.values()].some((button) => button === document.activeElement),
    [layoutRef],
  );
  useEffect(() => {
    const release = (event: PointerEvent) => {
      clearKeyboardFocus();
      if (!(event.target instanceof Element) || !event.target.closest("[data-pane-swap]"))
        focusRoot.current = null;
    };
    const leave = (event: FocusEvent) => {
      if (event.target !== keyboardFocusTarget.current) clearKeyboardFocus();
    };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("focusin", leave, true);
    return () => {
      clearKeyboardFocus();
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("focusin", leave, true);
    };
  }, [clearKeyboardFocus]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const { width, height } = grid.getBoundingClientRect();
      cancelAnimations();
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(grid);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [gridRef, cancelAnimations]);
  const rows = new Map(
    workspacePaneRects(layout.root, size).map((r, _index, all) => [
      r.paneId,
      findSwapRow(all, r.paneId),
    ]),
  );

  const swap = useCallback(
    (
      side: string,
      buttonActivation = true,
      keyboard = false,
      centerDirection?: "left" | "right",
    ): boolean => {
      const grid = gridRef.current;
      if (!grid || document.querySelector(modalSelector)) return false;
      const currentSize = grid.getBoundingClientRect();
      const row = findSwapRow(workspacePaneRects(layoutRef.current.root, currentSize), side);
      if (!row.available) {
        setAnnouncement(row.reason);
        return false;
      }
      if (row.middleId === side) return false;
      // Read live lifecycle state before capturing views or interrupting motion.
      // commit still authoritatively validates both participants at execution.
      if (closingPaneIdsRef.current.has(side) || closingPaneIdsRef.current.has(row.middleId)) {
        setAnnouncement(PANE_SWAP_CLOSING_REASON);
        return false;
      }
      const active = document.activeElement;
      const activeDirection =
        active instanceof HTMLElement && active.dataset.paneSwap === row.middleId
          ? active.dataset.paneSwapDirection
          : undefined;
      const direction =
        centerDirection ??
        (activeDirection === "left" || activeDirection === "right" ? activeDirection : undefined);
      const handoff =
        buttonActivation || active === buttons.current.get(side) || Boolean(direction);
      const focusId = direction ? side : row.middleId;
      const targetKey = direction ? `${side}:${direction}` : row.middleId;
      const origin = direction ? row.middleId : side;
      const restores = [side, row.middleId].flatMap((id) => {
        const view = views.current.get(id);
        return view ? [view.capture()] : [];
      });
      const before = new Map<string, DOMRect>();
      for (const id of [side, row.middleId]) {
        const host = hosts.current.get(id);
        if (host) before.set(id, host.getBoundingClientRect());
      }
      // Read the interrupted rendered locations before cancelling their transforms.
      cancelAnimations();
      let accepted = false;
      flushSync(() => {
        const next = commit(side, row.middleId, currentSize);
        if (!next) {
          setAnnouncement("Swap unavailable. Try again when the panes are ready.");
          return;
        }
        focusRoot.current = next.root;
        pending.current = {
          generation: ++generation.current,
          side,
          middle: row.middleId,
          targetKey,
          focusId,
          origin,
          active,
          handoff,
          keyboard,
          restores,
          root: next.root,
          before,
        };
        accepted = true;
        setAnnouncement(
          `${label(side)} moved into the middle.${handoff ? (direction ? " The focused center action can exchange the pair again." : " The focused side action can exchange the pair again.") : ""}`,
        );
      });
      return accepted;
    },
    [gridRef, layoutRef, closingPaneIdsRef, commit, label, cancelAnimations],
  );

  const swapFromMiddle = useCallback(
    (middle: string, direction: "left" | "right", keyboard: boolean) => {
      const grid = gridRef.current;
      if (!grid) return false;
      const row = findSwapRow(
        workspacePaneRects(layoutRef.current.root, grid.getBoundingClientRect()),
        middle,
      );
      if (!row.available || row.middleId !== middle) return false;
      const side = row.paneIds[row.paneIds.indexOf(middle) + (direction === "left" ? -1 : 1)];
      return side ? swap(side, true, keyboard, direction) : false;
    },
    [gridRef, layoutRef, swap],
  );

  useLayoutEffect(() => {
    const job = pending.current;
    if (!job) {
      cancelAnimations();
      return;
    }
    pending.current = null;
    if (job.generation !== generation.current) return;
    for (const restore of job.restores) restore();
    if (
      job.root === layout.root &&
      !document.hidden &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      const movements = [...job.before].flatMap(([id, before]) => {
        const host = hosts.current.get(id);
        return host ? [{ id, host, before, after: host.getBoundingClientRect() }] : [];
      });
      for (const { id, host, before, after } of movements) {
        if (typeof host.animate !== "function") continue;
        const effect = host.animate(
          [
            { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
            { transform: "translate(0px, 0px)" },
          ],
          { duration: 160, easing: "cubic-bezier(0, 0, 0.58, 1)" },
        );
        animations.current.set(id, effect);
        effect.onfinish = () => {
          // Completion only releases visual resources. It never commits or focuses.
          if (animations.current.get(id) === effect) animations.current.delete(id);
          effect.onfinish = null;
          effect.cancel();
        };
      }
    }
    if (!job.handoff) return;
    const active = document.activeElement;
    if (
      document.querySelector(modalSelector) ||
      (active !== job.active && active !== document.body && active?.isConnected)
    )
      return;
    const target = job.root === layout.root ? buttons.current.get(job.targetKey) : null;
    const fallback = hosts.current.get(job.origin) ?? gridRef.current;
    const destination = target && !target.disabled ? target : fallback;
    clearKeyboardFocus();
    if (destination && job.keyboard) {
      keyboardFocusTarget.current = destination;
      destination.setAttribute("data-swap-keyboard-focus", "");
    }
    destination?.focus({ preventScroll: true });
    if (destination === target) focusPane(job.focusId);
    else if (hosts.current.has(job.origin)) focusPane(job.origin);
  }, [layout.root, focusPane, gridRef, cancelAnimations, clearKeyboardFocus]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.getModifierState("AltGraph") ||
        !event.altKey ||
        !event.shiftKey ||
        (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      const active = document.activeElement;
      const grid = gridRef.current;
      if (
        !(active instanceof Element) ||
        !grid?.contains(active) ||
        document.querySelector(modalSelector)
      )
        return;
      const id = active.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      if (!id) return;
      const row = findSwapRow(
        workspacePaneRects(layoutRef.current.root, grid.getBoundingClientRect()),
        id,
      );
      if (!row.available) {
        setAnnouncement(row.reason);
        return;
      }
      const index = row.paneIds.indexOf(row.middleId) + (event.key === "ArrowLeft" ? -1 : 1);
      const side = row.paneIds[index];
      if (side && swap(side, false, true)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gridRef, layoutRef, swap]);
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const hidden = () => {
      if (document.hidden) cancelAnimations();
    };
    preference?.addEventListener("change", cancelAnimations);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      generation.current++;
      pending.current = null;
      cancelAnimations();
      preference?.removeEventListener("change", cancelAnimations);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [cancelAnimations]);
  const shortcutHelp = /Mac|iPhone|iPad/.test(navigator.platform)
    ? "Cmd+Option+Shift+Left or Right"
    : "Ctrl+Alt+Shift+Left or Right";
  return {
    rows,
    swap,
    swapFromMiddle,
    registerHost,
    registerButton,
    registerViewState,
    preserveFocus,
    announcement,
    help: `Swap with middle needs at least three panes in an unambiguous aligned row. ${shortcutHelp} exchanges the middle with its immediate left or right neighbour in the focused row, including while typing. Side buttons can exchange farther panes. The middle has left and right buttons to exchange with its immediate neighbours; focus stays on the same center action.`,
  };
}
export type WorkspacePaneSwaps = ReturnType<typeof useWorkspacePaneSwaps>;
