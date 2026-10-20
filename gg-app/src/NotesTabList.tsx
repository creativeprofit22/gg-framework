import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

export interface NotesTabItem<T extends string> {
  id: T;
  label: string;
  /** Decoration shown after the label, such as a count badge. */
  adornment?: ReactNode;
}

export interface NotesTabListProps<T extends string> {
  label: string;
  tabs: readonly NotesTabItem<T>[];
  activeId: T;
  onSelect(id: T): void;
  tabId(id: T): string;
  panelId(id: T): string;
  className: string;
  scrollClassName: string;
  /** Optional shared registry so the owner can focus a tab directly. */
  tabRefs?: RefObject<Partial<Record<T, HTMLButtonElement | null>>>;
}

/**
 * Horizontal focus intent for a looping tablist (after Radix RovingFocusGroup's
 * key map, MIT; re-implemented). Modified keys belong to the browser or app.
 */
function focusIntent(
  event: KeyboardEvent<HTMLButtonElement>,
): "prev" | "next" | "first" | "last" | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case "ArrowLeft":
      return "prev";
    case "ArrowRight":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

/**
 * Scrolls `scroller` horizontally just enough to show `tab` in full. The first
 * and last tabs (`edge`) snap to the scroll start/end so the list's inline
 * padding shows too. Vertical scroll positions are never touched, so the
 * surrounding panel keeps its place.
 */
export function revealTabHorizontally(
  scroller: HTMLElement,
  tab: HTMLElement,
  edge: "start" | "end" | null = null,
): void {
  if (edge === "start") {
    scroller.scrollLeft = 0;
    return;
  }
  if (edge === "end") {
    scroller.scrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    return;
  }
  const outer = scroller.getBoundingClientRect();
  const inner = tab.getBoundingClientRect();
  if (inner.left < outer.left) {
    scroller.scrollLeft -= outer.left - inner.left;
  } else if (inner.right > outer.right) {
    scroller.scrollLeft += Math.min(inner.right - outer.right, inner.left - outer.left);
  }
}

/** The one tablist used across Notes: roving focus, automatic activation, scrollable. */
export function NotesTabList<T extends string>({
  label,
  tabs,
  activeId,
  onSelect,
  tabId,
  panelId,
  className,
  scrollClassName,
  tabRefs,
}: NotesTabListProps<T>): ReactElement {
  const ownRefs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const refs = tabRefs ?? ownRefs;
  const scrollerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const tab = refs.current[activeId];
    if (!scroller || !tab) return;
    const edge =
      tab.previousElementSibling === null
        ? "start"
        : tab.nextElementSibling === null
          ? "end"
          : null;
    revealTabHorizontally(scroller, tab, edge);
  }, [activeId, refs]);

  const select = (id: T): void => {
    onSelect(id);
    refs.current[id]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: T): void => {
    const intent = focusIntent(event);
    if (intent === null || tabs.length === 0) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const count = tabs.length;
    const nextIndex =
      intent === "first"
        ? 0
        : intent === "last"
          ? count - 1
          : intent === "next"
            ? (index + 1) % count
            : (index - 1 + count) % count;
    const next = tabs[nextIndex];
    if (!next) return;
    event.preventDefault();
    select(next.id);
  };

  return (
    <div className={scrollClassName} ref={scrollerRef}>
      <div className={className} role="tablist" aria-label={label} aria-orientation="horizontal">
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                refs.current[tab.id] = element;
              }}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, tab.id)}
            >
              <span>{tab.label}</span>
              {tab.adornment}
            </button>
          );
        })}
      </div>
    </div>
  );
}
