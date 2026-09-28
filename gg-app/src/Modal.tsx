import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { withViewTransition } from "./view-transition";
import { ModalEmbedProvider, useModalEmbedState } from "./modal-embed";

// Nested confirmations can unmount with their parent on project switches.
// Reference counts restore the original state regardless of cleanup order.
const modalInertOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>();

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

interface ModalProps {
  /** When false, Escape, the backdrop and × do not dismiss the dialog. */
  canClose?: boolean;
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  /** Extra class on the `.modal` box (e.g. width overrides). */
  className?: string;
}

/**
 * Reusable centered modal with Escape, focus containment, and focus return.
 * Inside `<EmbeddedModal>` (the Settings screen's tabs) it renders its content
 * as a page section instead.
 */
export function Modal(props: ModalProps): React.ReactElement {
  return useModalEmbedState() === "embed" ? (
    <ModalSection {...props} />
  ) : (
    <ModalDialog {...props} />
  );
}

/**
 * The page form: the modal's content in flow, nothing floating. Its title is
 * the section's accessible name only; the page header names it on screen.
 */
function ModalSection({ title, children, className }: ModalProps): React.ReactElement {
  const titleId = useId();
  return (
    <section
      className={className ? `settings-panel ${className}` : "settings-panel"}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="sr-only">
        {title}
      </h2>
      <ModalEmbedProvider state="panel">{children}</ModalEmbedProvider>
    </section>
  );
}

function ModalDialog({
  title,
  children,
  onClose,
  className,
  canClose = true,
}: ModalProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The modal's own dismissals (Escape, backdrop, ×) animate out. Closes the
  // parent triggers itself (Save, Cancel) stay instant: they usually open the
  // next thing, and a fading ghost would sit over it.
  const dismiss = (): void => withViewTransition(onClose);
  // Focus handling stays local (not the shared useDialogFocus): the modal also
  // inerts the background, honours stacked dialogs and skips hidden controls.
  const onCloseRef = useRef(dismiss);

  useEffect(() => {
    onCloseRef.current = canClose ? () => withViewTransition(onClose) : () => undefined;
  }, [onClose, canClose]);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
    );
    for (const element of background) {
      const owner = modalInertOwners.get(element) ?? { count: 0, original: element.inert === true };
      owner.count++;
      modalInertOwners.set(element, owner);
      element.inert = true;
    }
    const initialFocus = dialog
      ? (availableModalElements(dialog, "[data-modal-initial-focus]")[0] ??
        availableModalElements(dialog, "[role='tab'][aria-selected='true']")[0] ??
        modalFocusableElements(dialog)[0] ??
        dialog)
      : null;
    initialFocus?.focus();

    const onKey = (event: KeyboardEvent): void => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.item(dialogs.length - 1) !== dialog) return;
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
      for (const element of background) {
        const owner = modalInertOwners.get(element);
        if (owner && --owner.count === 0) {
          element.inert = owner.original;
          modalInertOwners.delete(element);
        }
      }
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
        if (canClose && event.target === event.currentTarget) dismiss();
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
            disabled={!canClose}
            onClick={dismiss}
          >
            <XIcon size={14} weight="bold" aria-hidden="true" />
          </button>
        </div>
        {/* A dialog's own contents are never embedded, even when a page
            section opened it. */}
        <ModalEmbedProvider state="none">{children}</ModalEmbedProvider>
      </div>
    </div>,
    document.body,
  );
}
