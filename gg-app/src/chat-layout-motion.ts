import { prefersReducedMotion } from "./transcript-motion";

// Mirrored by scripts/motion-tokens.test.mjs. Layout moves, text never scales.
const DURATION_MS = 220;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const MAX_VISIBLE_ROWS = 80;

interface LayoutNodes {
  transcript: HTMLElement | null;
  surfaces: readonly (HTMLElement | null)[];
}
interface Position {
  node: HTMLElement;
  left: number;
  top: number;
}
interface Snapshot {
  transcript: HTMLElement;
  positions: Position[];
  anchor: { node: HTMLElement; offset: number } | null;
}

export interface ChatLayoutMotion {
  /** Call immediately before the state update, not from a state updater. */
  capture: () => void;
  /** Call after autosizing and transcript layout effects, before paint. */
  commit: (pinned: boolean, follow: () => void) => boolean;
  /** Manual input, resize, session change, hide and unmount end owned motion. */
  cancel: () => void;
  /** Release transforms before App reads real scroll geometry. Keeps a capture. */
  settle: () => void;
  /** Ignore the observer notification for the layout we already committed. */
  resized: () => boolean;
}

/** A bounded transaction, not a scroll animator. App still owns scroll intent.
 * Binary search skips offscreen history; only visible rows and two surfaces
 * are held until the next commit. There is no timer or frame loop. */
export function createChatLayoutMotion(nodes: () => LayoutNodes): ChatLayoutMotion {
  let pending: Snapshot | null = null;
  let expiry: number | null = null;
  const clearExpiry = () => {
    if (expiry !== null) cancelAnimationFrame(expiry);
    expiry = null;
  };
  let width = 0;
  let height = 0;
  const animations = new Set<Animation>();
  const cancelAnimations = () => {
    for (const animation of animations) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    animations.clear();
  };
  const cancel = () => {
    clearExpiry();
    pending = null;
    cancelAnimations();
  };
  return {
    cancel,
    settle: cancelAnimations,
    resized() {
      const { transcript } = nodes();
      const nextWidth = transcript?.clientWidth ?? 0;
      const nextHeight = transcript?.clientHeight ?? 0;
      if (width === nextWidth && height === nextHeight) return false;
      width = nextWidth;
      height = nextHeight;
      cancel();
      return true;
    },
    capture() {
      // Several events batched into one React commit share the first snapshot.
      if (pending) return;
      const { transcript, surfaces } = nodes();
      if (!transcript || !transcript.clientHeight) return;
      const viewport = transcript.getBoundingClientRect();
      const children = transcript.children;
      let lo = 0;
      let hi = children.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const child = children.item(mid);
        if (child && child.getBoundingClientRect().bottom <= viewport.top) lo = mid + 1;
        else hi = mid;
      }
      const positions: Position[] = [];
      let anchor: Snapshot["anchor"] = null;
      for (let i = lo; i < children.length && i < lo + MAX_VISIBLE_ROWS; i++) {
        const node = children.item(i);
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top >= viewport.bottom) break;
        if (rect.height === 0) continue;
        // offsetTop deliberately ignores our in-flight transform. Anchoring is
        // layout, whereas the FLIP snapshot is what is currently displayed.
        anchor ??= { node, offset: node.offsetTop - transcript.scrollTop };
        positions.push({ node, left: rect.left, top: rect.top });
      }
      for (const node of surfaces) {
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width && rect.height) positions.push({ node, left: rect.left, top: rect.top });
      }
      pending = { transcript, positions, anchor };
      // A no-op state setter may never commit. Do not carry its old geometry
      // into a later interaction. One expiry frame, never a frame loop.
      if (typeof requestAnimationFrame === "function")
        expiry = requestAnimationFrame(() => {
          pending = null;
          expiry = null;
        });
      cancelAnimations();
    },
    commit(pinned, follow) {
      clearExpiry();
      const snapshot = pending;
      pending = null;
      if (!snapshot) return false;
      // A reversal captured the displayed positions before this cancellation.
      cancelAnimations();
      const { transcript, positions, anchor } = snapshot;
      if (!transcript.isConnected || !transcript.clientHeight) return false;
      width = transcript.clientWidth;
      height = transcript.clientHeight;
      if (pinned) follow();
      else if (anchor?.node.parentElement === transcript) {
        transcript.scrollTop = anchor.node.offsetTop - anchor.offset;
      }
      if (prefersReducedMotion()) return true;
      // Batch all reads before animation writes. Rect / offsetWidth converts
      // viewport pixels back to local layout pixels at the user's CSS zoom.
      const moves = positions.flatMap(({ node, left, top }) => {
        if (!node.isConnected || typeof node.animate !== "function") return [];
        const rect = node.getBoundingClientRect();
        if (!rect.width || !node.offsetWidth) return [];
        const scale = rect.width / node.offsetWidth;
        const x = (left - rect.left) / scale;
        const y = (top - rect.top) / scale;
        return Math.abs(x) < 0.5 && Math.abs(y) < 0.5 ? [] : [{ node, x, y }];
      });
      for (const { node, x, y } of moves) {
        const animation = node.animate([{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }], {
          duration: DURATION_MS,
          easing: EASING,
        });
        animations.add(animation);
        const release = () => {
          animations.delete(animation);
          animation.onfinish = null;
          animation.oncancel = null;
        };
        animation.onfinish = release;
        animation.oncancel = release;
      }
      return true;
    },
  };
}
