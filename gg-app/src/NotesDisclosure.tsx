import { useState, type ReactElement, type ReactNode } from "react";

const STORAGE_PREFIX = "gg-notes-disclosure:";

function readExpanded(storageKey: string | null): boolean {
  if (!storageKey) return false;
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + storageKey) === "open";
  } catch {
    return false;
  }
}

function writeExpanded(storageKey: string | null, expanded: boolean): void {
  if (!storageKey) return;
  try {
    sessionStorage.setItem(STORAGE_PREFIX + storageKey, expanded ? "open" : "closed");
  } catch {
    // Storage unavailable: the choice lasts until this component unmounts.
  }
}

/**
 * Expansion for a disclosure, remembered per window session under `storageKey`
 * (memory-only while the key is null). Collapsed by default.
 *
 * `forceOpen` reveals the content without changing the remembered choice, so a
 * selected item inside stays visible. The reveal holds after `forceOpen` clears
 * (closing a detail returns focus to a row that is still shown) until the user
 * toggles or the group remounts. A toggle while revealed collapses and is remembered.
 */
export function useSessionDisclosure(
  storageKey: string | null,
  forceOpen: boolean,
): [boolean, () => void] {
  const [key, setKey] = useState(storageKey);
  const [stored, setStored] = useState(() => readExpanded(storageKey));
  const [lastForceOpen, setLastForceOpen] = useState(forceOpen);
  const [revealed, setRevealed] = useState(forceOpen);

  if (key !== storageKey) {
    setKey(storageKey);
    setStored(readExpanded(storageKey));
  }
  if (lastForceOpen !== forceOpen) {
    setLastForceOpen(forceOpen);
    if (forceOpen) setRevealed(true);
  }

  const expanded = revealed || stored;
  const toggle = () => {
    const next = !expanded;
    setRevealed(false);
    setStored(next);
    writeExpanded(storageKey, next);
  };
  return [expanded, toggle];
}

export interface NotesDisclosureProps {
  /** DOM id of the collapsible region; the toggle points at it. */
  id: string;
  label: ReactNode;
  expanded: boolean;
  onToggle(): void;
  /** Marks the toggle as the focus target when a focused row disappears. */
  focusFallback?: boolean;
  className?: string;
  /** Extra classes for the region, beside `notes-disclosure-region`. */
  regionClassName?: string;
  children: ReactNode;
}

/**
 * The one disclosure used across Notes (after Radix Collapsible's trigger wiring,
 * MIT; re-implemented): a native button, so Enter and Space work without handlers.
 */
export function NotesDisclosure({
  id,
  label,
  expanded,
  onToggle,
  focusFallback = false,
  className,
  regionClassName,
  children,
}: NotesDisclosureProps): ReactElement {
  const state = expanded ? "open" : "closed";
  return (
    <div className={className}>
      <button
        type="button"
        className="notes-archive-toggle notes-disclosure-toggle"
        aria-expanded={expanded}
        aria-controls={id}
        data-state={state}
        data-phase-focus-fallback={focusFallback ? "" : undefined}
        onClick={onToggle}
      >
        <svg
          className="notes-disclosure-chevron"
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          width="12"
          height="12"
        >
          <path
            d="M6 4l4 4-4 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{label}</span>
      </button>
      <div
        id={id}
        className={
          regionClassName ? `notes-disclosure-region ${regionClassName}` : "notes-disclosure-region"
        }
        data-state={state}
        hidden={!expanded}
      >
        {children}
      </div>
    </div>
  );
}
