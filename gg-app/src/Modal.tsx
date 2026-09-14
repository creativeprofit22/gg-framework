import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { theme } from "./theme";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isAvailableForModalFocus(element: HTMLElement, dialog: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const styles = window.getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
      current.hasAttribute("inert") ||
      (current as HTMLElement & { inert?: boolean }).inert === true ||
      styles.display === "none" ||
      styles.visibility === "hidden" ||
      styles.visibility === "collapse" ||
      styles.contentVisibility === "hidden"
    ) {
      return false;
    }
    if (current === dialog) return true;
    current = current.parentElement;
  }
  return false;
}

function availableModalElements(dialog: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) =>
    isAvailableForModalFocus(element, dialog),
  );
}

function modalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return availableModalElements(dialog, FOCUSABLE_SELECTOR);
}

/** Reusable centered modal with Escape, focus containment, and focus return. */
export function Modal({
  title,
  children,
  onClose,
  className,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  /** Extra class on the `.modal` box (e.g. width overrides). */
  className?: string;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initialFocus = dialog
      ? (availableModalElements(dialog, "[data-modal-initial-focus]")[0] ??
        availableModalElements(dialog, "[role='tab'][aria-selected='true']")[0] ??
        modalFocusableElements(dialog)[0] ??
        dialog)
      : null;
    initialFocus?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = modalFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
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
  }, []);

  // Portalled to <body>. A modal opened from a trigger nested inside the app
  // shell (the radio button lives in the nav bar) would otherwise be trapped in
  // that ancestor's stacking context, and paint UNDER later siblings — the
  // transcript showed straight through the panel. Rendering at the document
  // root makes every modal immune to wherever its trigger happens to live.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        style={{ background: theme.surface2, borderColor: theme.border }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId} className="modal-title" style={{ color: theme.text }}>
            {title}
          </h2>
          <button
            className="modal-close"
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            {"\u00d7"}
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
