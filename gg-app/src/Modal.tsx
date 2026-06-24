import { useEffect } from "react";
import { theme } from "./theme";

/**
 * Reusable centered modal with a dim backdrop. Closes on Escape or backdrop
 * click. Presentational — the caller owns the body and actions.
 */
export function Modal({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  /** Extra class on the `.modal` box (e.g. width overrides). */
  className?: string;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={className ? `modal ${className}` : "modal"}
        style={{ background: theme.surface2, borderColor: theme.border }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" style={{ color: theme.text }}>
            {title}
          </div>
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
