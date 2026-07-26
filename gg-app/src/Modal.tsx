import { useEffect, useId, useRef } from "react";
import { theme } from "./theme";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].join(",");

function isFocusableElement(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 && element.closest("[hidden], [aria-hidden='true'], [inert]") === null
  );
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusableElement,
  );
}

function getInitialFocus(dialog: HTMLElement): HTMLElement {
  const focusable = getFocusableElements(dialog);
  return (
    focusable.find(
      (element) =>
        element.getAttribute("role") === "tab" && element.getAttribute("aria-selected") === "true",
    ) ??
    focusable.find((element) => element.hasAttribute("data-modal-initial-focus")) ??
    focusable[0] ??
    dialog
  );
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
    const initialFocus = dialog ? getInitialFocus(dialog) : null;
    initialFocus?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = getFocusableElements(dialog);
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

  return (
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
    </div>
  );
}
