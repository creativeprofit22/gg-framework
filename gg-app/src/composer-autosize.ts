// Auto-grow the chat textarea to fit its content, up to a CSS max-height after
// which it scrolls — without disturbing the transcript scrolling above it.
//
// Lives outside App.tsx so the scroll-preservation contract below is testable
// (`composer-autosize.test.ts` models the browser's clamp; jsdom has no layout).
//
// Measure with the scrollbar suppressed. `height: auto` collapses the textarea
// to its rows=1 intrinsic height, so any wrapped draft overflows during
// measurement, and `.input::-webkit-scrollbar` is a classic (space-consuming)
// scrollbar in WebKit — verified 8px of content width lost while it shows.
// Suppressing it first means every read below sees the width the text is
// actually laid out at, including the overflow decision itself.
export function autosizeComposer(
  el: HTMLTextAreaElement | null,
  transcript: HTMLElement | null,
): void {
  if (!el) return;
  // That same `height: auto` collapse hands the composer's pixels back to the
  // transcript for one layout pass. If the transcript's content fits in the
  // briefly-taller viewport, the browser clamps its scrollTop toward 0; the
  // scroll event that follows reads as "the user scrolled up", drops App's
  // stick-to-bottom pin for good, and from then on the growing composer covers
  // the newest messages instead of pushing them up. It only shows past ~3 line
  // breaks, where the lost distance clears the pin's 48px threshold. Snapshot
  // and restore around the measurement so the collapse stays invisible: both
  // writes land in the same task, so the browser fires at most one scroll
  // event, carrying the restored offset.
  const savedTop = transcript?.scrollTop;
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
  const content = el.scrollHeight;
  el.style.height = `${Math.min(content, max)}px`;
  // Only past the cap does the scrollbar earn its width. Below it, keeping
  // overflow hidden also avoids a phantom grey scrollbar under CSS zoom > 1,
  // where scrollHeight rounds down to an integer of unzoomed px and leaves the
  // content a hair taller than the height just set.
  if (content > max) el.style.overflowY = "auto";
  if (transcript && savedTop !== undefined && transcript.scrollTop !== savedTop) {
    transcript.scrollTop = savedTop;
  }
}
