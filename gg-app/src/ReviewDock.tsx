import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Maximize2, Minimize2 } from "lucide-react";

export interface ReviewDockItem {
  id: "plan" | "roadmap";
  identity: string;
  label: string;
  summary: string;
  content: ReactNode;
}
interface Props {
  items: ReviewDockItem[];
  expanded: ReviewDockItem["id"] | null;
  onExpandedChange: (id: ReviewDockItem["id"] | null) => void;
  onLayoutChange?: () => void;
  fallbackFocus?: () => void;
}

/** Non-modal pane-local inspection shell. Decisions remain with their typed owners. */
export function ReviewDock({
  items,
  expanded,
  onExpandedChange,
  onLayoutChange,
  fallbackFocus,
}: Props) {
  const id = useId();
  const [maximizedIdentity, setMaximizedIdentity] = useState<string | null>(null);
  const activeItem = items.find((item) => item.id === expanded);
  const activeIdentity = activeItem ? `${activeItem.id}:${activeItem.identity}` : null;
  const maximized = activeIdentity !== null && maximizedIdentity === activeIdentity;
  const changeExpanded = (next: ReviewDockItem["id"] | null) => {
    setMaximizedIdentity(null);
    if (next === null && root.current?.contains(document.activeElement)) {
      root.current.querySelector<HTMLButtonElement>(`[data-review-trigger="${expanded}"]`)?.focus();
    }
    onExpandedChange(next);
  };
  const root = useRef<HTMLElement>(null);
  const focusedReview = useRef<string | null>(null);
  const previous = useRef(expanded);
  const fallbackFocusRef = useRef(fallbackFocus);
  useLayoutEffect(() => {
    fallbackFocusRef.current = fallbackFocus;
  }, [fallbackFocus]);
  const signature = items.map((item) => `${item.id}:${item.identity}`).join("|");
  useLayoutEffect(() => {
    const focused = focusedReview.current;
    const trigger = focused
      ? root.current?.querySelector<HTMLButtonElement>(`[data-review-trigger="${focused}"]`)
      : null;
    if (focused && (previous.current !== expanded || !trigger)) {
      // Only restore focus if it was inside the review being hidden/removed.
      if (trigger) trigger.focus();
      else if (document.activeElement === document.body) fallbackFocusRef.current?.();
      focusedReview.current = null;
    }
    previous.current = expanded;
    onLayoutChange?.();
  }, [expanded, signature, maximized, onLayoutChange]);
  if (items.length === 0) return null;
  return (
    <section
      ref={root}
      className={`review-dock${expanded ? " is-expanded" : ""}${maximized ? " is-maximized" : ""}`}
      aria-label="Pending reviews"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && expanded) {
          event.preventDefault();
          event.stopPropagation();
          changeExpanded(null);
        }
      }}
    >
      <div className="review-dock-header">
        <div className="review-dock-tabs">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="btn btn-ghost review-dock-trigger"
              data-review-trigger={item.id}
              id={`${id}-${item.id}-trigger`}
              aria-expanded={expanded === item.id}
              aria-controls={`${id}-${item.id}-body`}
              onClick={() => changeExpanded(expanded === item.id ? null : item.id)}
            >
              {expanded === item.id ? (
                <ChevronDown size={16} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} aria-hidden="true" />
              )}
              <span>
                <strong>{item.label}</strong>
                <span className="review-dock-summary">{item.summary}</span>
              </span>
              <span className="review-dock-toggle">
                {expanded === item.id ? "Collapse" : "Focus review"}
              </span>
            </button>
          ))}
        </div>
        {activeItem && (
          <button
            type="button"
            className="btn btn-ghost review-dock-size"
            aria-label={maximized ? "Restore review size" : "Expand review to output area"}
            title={maximized ? "Restore review size" : "Expand review to output area"}
            aria-pressed={maximized}
            aria-controls={`${id}-${activeItem.id}-body`}
            onClick={() => setMaximizedIdentity(maximized ? null : activeIdentity)}
          >
            {maximized ? (
              <Minimize2 size={18} aria-hidden="true" />
            ) : (
              <Maximize2 size={18} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {items.map((item) => (
        <div
          key={`${item.id}:${item.identity}`}
          id={`${id}-${item.id}-body`}
          className="review-dock-panel"
          role="region"
          aria-labelledby={`${id}-${item.id}-trigger`}
          hidden={expanded !== item.id}
          onFocusCapture={() => {
            focusedReview.current = item.id;
          }}
          onBlurCapture={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
              focusedReview.current = null;
          }}
        >
          {item.content}
        </div>
      ))}
    </section>
  );
}
