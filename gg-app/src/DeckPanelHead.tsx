import type { ReactNode } from "react";
import { Icon } from "./icons";

/** A panel's header: its name, then "esc" and a close key on the right. */
export function PanelHead({
  title,
  meta,
  onClose,
}: {
  title: string;
  meta?: ReactNode;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="deck-prow tool-head">
      <h2 className="tool-title">{title}</h2>
      {meta && <span className="deck-pm">{meta}</span>}
      <span className="deck-spacer" />
      <span className="deck-hint" aria-hidden="true">
        esc
      </span>
      <button
        type="button"
        className="key key-icon key-sm"
        aria-label={`Close ${title}`}
        title="Close"
        onClick={onClose}
      >
        <Icon name="xmark" size={13} />
      </button>
    </div>
  );
}
