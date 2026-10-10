import { createContext, useContext } from "react";
import { withViewTransition } from "./view-transition";

/**
 * Lets a modal's content render as a page section instead of a floating
 * dialog. The full-screen Settings screen wraps each tab's panel (the same
 * components the tray and chat view still open as dialogs) in
 * `<EmbeddedModal>`; the panel's `<Modal>` then draws an inline section with
 * no backdrop, close button, focus trap or Escape handling.
 *
 * Three states, so embedding applies to exactly one level:
 * - `embed`: the next `<Modal>` down renders as a page section;
 * - `panel`: inside that section. Cancel/Close buttons hide (the screen's own
 *   Back does that job), and any further `<Modal>` is a real dialog again;
 * - `none`: ordinary dialogs.
 */
export type ModalEmbedState = "none" | "embed" | "panel";

const ModalEmbedContext = createContext<ModalEmbedState>("none");

export function ModalEmbedProvider({
  state,
  children,
}: {
  state: ModalEmbedState;
  children: React.ReactNode;
}): React.ReactElement {
  return <ModalEmbedContext.Provider value={state}>{children}</ModalEmbedContext.Provider>;
}

/**
 * Shows the modal inside as a page section (see the file comment). The
 * section's title stays as its accessible name but is not drawn: the page's
 * header already names it.
 */
export function EmbeddedModal({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ModalEmbedProvider state="embed">{children}</ModalEmbedProvider>;
}

export function useModalEmbedState(): ModalEmbedState {
  return useContext(ModalEmbedContext);
}

/**
 * A modal's Cancel / Close button. On a page there is nothing to dismiss (the
 * screen's own Back does that), so it renders nothing there.
 */
export function ModalDismissButton({
  onClick,
  children,
  disabled = false,
  animateDismiss = true,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Async dismissals animate their eventual state update instead. */
  animateDismiss?: boolean;
}): React.ReactElement | null {
  if (useModalEmbedState() === "panel") return null;
  return (
    <button
      className="modal-btn"
      type="button"
      disabled={disabled}
      onClick={() => {
        if (animateDismiss) withViewTransition(onClick);
        else onClick();
      }}
    >
      {children}
    </button>
  );
}
