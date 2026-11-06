import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keyboard behaviour shared by every modal surface: move focus in on mount,
 * keep Tab / Shift+Tab cycling inside, and return focus to the opener on
 * unmount. Initial focus goes to `[data-modal-initial-focus]`, then the
 * selected tab, then the first focusable control, then the dialog itself.
 *
 * `onEscape` is optional: a surface that demands a decision (plan review) can
 * omit it so Escape never silently picks one of its outcomes.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
): void {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initialFocus =
      dialog?.querySelector<HTMLElement>("[data-modal-initial-focus]") ??
      dialog?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      dialog;
    initialFocus?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        const handler = onEscapeRef.current;
        if (!handler) return;
        event.preventDefault();
        handler();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnFocus?.focus();
    };
  }, [dialogRef]);
}
