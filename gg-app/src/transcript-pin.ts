/**
 * Whether the transcript follows new output ("pinned" to the newest line).
 *
 * Lives outside App.tsx so the rules are testable without layout
 * (`transcript-pin.test.ts`); App feeds it the transcript's scroll and wheel
 * events and only auto-scrolls while it answers true.
 *
 * The pin follows the reader's DIRECTION, never their position alone. While a
 * reply streams, App re-pins on every commit (~30 times a second), so a rule
 * of "pinned while within 48px of the bottom" re-captured anyone who had not
 * yet scrolled past 48px in one go — a trackpad glide, one wheel notch — and
 * anyone the layout clamped back near the bottom (the tool panel below
 * closing, a reply past 8 KB folding its tail away). Each re-capture snapped
 * them back down on the next commit. So: any upward move by the reader
 * un-pins, and only moving back down near the bottom re-pins.
 */

/** A scroll down that ends this close to the bottom resumes following. */
export const REPIN_DISTANCE_PX = 48;

/**
 * Slack for "exactly at the bottom": scrollTop is fractional under zoom while
 * scrollHeight and clientHeight are each rounded to whole pixels, so a clamped
 * offset can read up to a pixel or so off zero.
 */
const AT_BOTTOM_PX = 2;

/** The scroll geometry the rules read — an HTMLElement satisfies it. */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The wheel fields the rules read — a WheelEvent satisfies it. */
export interface WheelIntent {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrlKey: boolean;
}

/** Pixels of content below the visible bottom edge. */
export function distanceFromBottom(el: ScrollGeometry): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * The pin after a scroll event. `lastTop` is the offset at the previous scroll
 * event OR App's own last scroll-to-bottom, whichever is later: a reader's
 * move that shares a frame with a re-pin must be measured from where the
 * re-pin left the view, or an up-scroll reads as down.
 */
export function pinAfterScroll(pinned: boolean, lastTop: number, el: ScrollGeometry): boolean {
  // Content that fits the viewport (say, a cleared conversation) has nothing
  // above it to read, so whatever arrives next should be followed.
  if (el.scrollHeight <= el.clientHeight) return true;
  const distance = distanceFromBottom(el);
  if (el.scrollTop < lastTop) {
    // Up to exactly the bottom is the browser clamping the offset after the
    // content got shorter or the viewport taller — layout, not the reader.
    return distance <= AT_BOTTOM_PX ? pinned : false;
  }
  if (el.scrollTop > lastTop && distance <= REPIN_DISTANCE_PX) return true;
  return pinned;
}

/**
 * The pin after a wheel event, which arrives BEFORE the scroll it causes.
 * Un-pinning here means no streaming commit can re-pin between the reader's
 * gesture and its scroll event and erase the move before it is measured.
 */
export function pinAfterWheel(pinned: boolean, wheel: WheelIntent, el: ScrollGeometry): boolean {
  // Pinch-zoom arrives as ctrl+wheel. A sideways swipe across a wide markdown
  // table (code blocks wrap, so tables are the only sideways scroller here)
  // carries a little vertical noise; only a mostly-vertical gesture means up
  // or down.
  if (wheel.ctrlKey || Math.abs(wheel.deltaY) <= Math.abs(wheel.deltaX)) return pinned;
  // Without overflow there is nothing to scroll up to.
  if (wheel.deltaY < 0) return el.scrollHeight > el.clientHeight ? false : pinned;
  // Down near the bottom resumes following — even at the very bottom, where
  // the offset cannot move and so no scroll event will follow.
  return distanceFromBottom(el) <= REPIN_DISTANCE_PX ? true : pinned;
}
