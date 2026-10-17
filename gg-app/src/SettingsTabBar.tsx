import { useLayoutEffect, useRef } from "react";
import type { Icon } from "@phosphor-icons/react";
import { viewportScale } from "./motion-geometry";

/**
 * The Settings screen's floating capsule of tabs, ported from yaatuber's
 * settings tab bar (segmented-tabs.ts, itself Glance's SettingsTabBar):
 * icon-only tabs, with the selected tab widening to show its label under one
 * pill. Hover only lightens a tab. Selecting one (click, or arrow keys) springs
 * the whole capsule at once: the old label folds into its icon while the new
 * one unfurls out of its own, and the pill travels between them. Labels and
 * pill share one spring, so the capsule's width, the tabs' places and the pill
 * stay in step the whole way (snapping the layout and springing only the pill
 * made every tab hop while the pill caught up).
 */

export interface SettingsTab<Id extends string> {
  id: Id;
  label: string;
  icon: Icon;
  /** A small red dot on the icon: something on this tab needs attention. */
  alert?: boolean;
}

interface Props<Id extends string> {
  tabs: readonly SettingsTab<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  /** Id of the panel element the tabs control. */
  panelId: string;
  /** Accessible name and tab ids when this control is reused outside Settings. */
  label?: string;
  tabIdPrefix?: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where everything sat just before a selection change (mid-spring included). */
interface Before {
  bar: DOMRect;
  pill: DOMRect | null;
  /** Per tab id: its label's width and opacity, and the tab's side padding. */
  tabs: Map<string, { label: number; opacity: string; padLeft: string; padRight: string }>;
}

function tabButtons(bar: HTMLElement): HTMLElement[] {
  return Array.from(bar.querySelectorAll<HTMLElement>(":scope > [data-tab-id]"));
}

function labelOf(tab: HTMLElement): HTMLElement | null {
  return tab.querySelector<HTMLElement>(".settings-tab-label");
}

function readMotion(): { easing: string; durationMs: number; reduced: boolean } {
  const style = getComputedStyle(document.documentElement);
  const seconds = parseFloat(style.getPropertyValue("--duration-spring"));
  return {
    easing: style.getPropertyValue("--ease-spring").trim() || "ease-out",
    durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500,
    // No Web Animations (older WebKit, jsdom) is treated like reduced motion:
    // the pill still lands on the right tab, it just does not travel.
    reduced:
      typeof Element.prototype.animate !== "function" ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  };
}

function boxOf(tab: HTMLElement): Box {
  return { x: tab.offsetLeft, y: tab.offsetTop, width: tab.offsetWidth, height: tab.offsetHeight };
}

function paint(pill: HTMLElement, box: Box): void {
  pill.style.width = `${box.width}px`;
  pill.style.height = `${box.height}px`;
  pill.style.transform = `translate(${box.x}px, ${box.y}px)`;
}

function placementKey(bar: HTMLElement, box: Box): string {
  const rect = bar.getBoundingClientRect();
  return [
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    viewportScale(bar, rect),
    box.x,
    box.y,
    box.width,
    box.height,
  ].join(":");
}

function cancelOwned(animations: Set<Animation>): void {
  for (const animation of animations) {
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
  }
  animations.clear();
}

export function SettingsTabBar<Id extends string>({
  tabs,
  selected,
  onSelect,
  panelId,
  label = "Settings sections",
  tabIdPrefix = "settings-tab",
}: Props<Id>): React.ReactElement {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const beforeRef = useRef<Before | null>(null);
  const animationsRef = useRef(new Set<Animation>());
  const placementRef = useRef("");
  // Re-checks the pill once the spring ends (set by the layout effect below).
  const settledRef = useRef<(() => void) | null>(null);

  function select(id: Id): void {
    const bar = barRef.current;
    if (id === selected || !bar) return;
    const pill = pillRef.current;
    beforeRef.current = {
      bar: bar.getBoundingClientRect(),
      pill: pill?.classList.contains("is-placed") ? pill.getBoundingClientRect() : null,
      tabs: new Map(
        tabButtons(bar).map((el) => {
          const style = getComputedStyle(el);
          const label = labelOf(el);
          return [
            el.dataset["tabId"] ?? "",
            {
              label: label?.offsetWidth ?? 0,
              opacity: label ? getComputedStyle(label).opacity : "0",
              padLeft: style.paddingLeft,
              padRight: style.paddingRight,
            },
          ];
        }),
      ),
    };
    onSelect(id);
  }

  // Selection changed: put the pill on the new tab and, unless motion is
  // reduced, spring the labels, paddings and pill from where they were a
  // moment ago. Every moving length interpolates on the same curve, so each
  // tab's place (a sum of them) does too, and the pill lands on its tab at
  // every frame, not just at the end.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const target = bar.querySelector<HTMLElement>(`:scope > [data-tab-id="${selected}"]`);
    if (!target) return;
    const before = beforeRef.current;
    beforeRef.current = null;

    cancelOwned(animationsRef.current);
    const to = boxOf(target);
    paint(pill, to);
    pill.classList.add("is-placed");
    placementRef.current = placementKey(bar, to);

    const motion = readMotion();
    if (!before || motion.reduced) return;
    const spring = { duration: motion.durationMs, easing: motion.easing };
    const scale = viewportScale(bar, bar.getBoundingClientRect());
    const animate = (el: Element, frames: Keyframe[]): void => {
      const animation = el.animate(frames, spring);
      const owned = animationsRef.current;
      owned.add(animation);
      const release = (): void => {
        owned.delete(animation);
        animation.onfinish = null;
        animation.oncancel = null;
        // A font or layout change that landed mid-spring is picked up now.
        if (owned.size === 0) settledRef.current?.();
      };
      animation.onfinish = release;
      animation.oncancel = release;
    };
    let targetOpened = false;
    for (const el of tabButtons(bar)) {
      const old = before.tabs.get(el.dataset["tabId"] ?? "");
      if (!old) continue;
      const style = getComputedStyle(el);
      if (old.padLeft !== style.paddingLeft || old.padRight !== style.paddingRight) {
        animate(el, [
          { paddingLeft: old.padLeft, paddingRight: old.padRight },
          { paddingLeft: style.paddingLeft, paddingRight: style.paddingRight },
        ]);
      }
      const label = labelOf(el);
      if (!label) continue;
      const width = label.offsetWidth;
      if (Math.abs(old.label - width) < 0.5) continue;
      if (el === target) {
        targetOpened = true;
        animate(label, [
          { width: `${old.label}px`, opacity: 0 },
          { width: `${width}px`, opacity: 1 },
        ]);
      } else {
        // Folding back into its icon, fading as it goes.
        animate(label, [
          { width: `${old.label}px`, opacity: old.opacity || 1 },
          { width: `${width}px`, opacity: 0 },
        ]);
      }
    }

    if (before.pill) {
      // In the bar's own coordinates as it was then: the labels restart from
      // their old widths, so at the first frame the bar is back where it was.
      const from: Box = {
        x: (before.pill.left - before.bar.left) / scale - bar.clientLeft,
        y: (before.pill.top - before.bar.top) / scale - bar.clientTop,
        width: before.pill.width / scale,
        height: before.pill.height / scale,
      };
      animate(pill, [
        {
          width: `${from.width}px`,
          height: `${from.height}px`,
          transform: `translate(${from.x}px, ${from.y}px)`,
        },
        {
          width: `${to.width}px`,
          height: `${to.height}px`,
          transform: `translate(${to.x}px, ${to.y}px)`,
        },
      ]);
    }

    // The new label fades in even when it has no width to spring (first
    // layout, or a measurement-free environment).
    const label = labelOf(target);
    if (label && !targetOpened) animate(label, [{ opacity: 0 }, { opacity: 1 }]);
  }, [selected]);

  // Layout changes that are not a selection (fonts landing, a window resize)
  // re-place the pill instantly.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const owned = animationsRef.current;
    const place = (): void => {
      const target = bar.querySelector<HTMLElement>(":scope > [aria-selected='true']");
      if (!target || target.offsetWidth <= 0) return;
      const box = boxOf(target);
      const key = placementKey(bar, box);
      // Selection itself resizes the dock. Its observer delivery must not
      // cancel the animation just started by the selection layout effect.
      if (key === placementRef.current) return;
      placementRef.current = key;
      beforeRef.current = null;
      cancelOwned(owned);
      paint(pill, box);
    };
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) place();
    });
    // The spring itself resizes the bar every frame, so the bar's own resize
    // observer waits for it to finish; outside changes (window, zoom) still
    // cut in at once.
    const placeWhenSettled = (): void => {
      if (owned.size === 0) place();
    };
    settledRef.current = placeWhenSettled;
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(placeWhenSettled) : null;
    observer?.observe(bar);
    // CSS zoom can leave local ResizeObserver sizes unchanged. ZoomController
    // writes the root style; window resize covers repositioning of the dock.
    const zoomObserver = new MutationObserver(place);
    zoomObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("resize", place);
    return () => {
      alive = false;
      settledRef.current = null;
      observer?.disconnect();
      zoomObserver.disconnect();
      window.removeEventListener("resize", place);
      beforeRef.current = null;
      cancelOwned(owned);
    };
  }, []);

  // Arrow keys, Home and End move between tabs, selecting as they go (the
  // tabs pattern with automatic activation, as in yaatuber).
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    const target = next === null ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    select(target.id);
    barRef.current?.querySelector<HTMLElement>(`:scope > [data-tab-id="${target.id}"]`)?.focus();
  }

  return (
    <div className="settings-tab-dock">
      <div className="settings-tabs" ref={barRef} role="tablist" aria-label={label}>
        <span className="settings-tabs-pill" ref={pillRef} aria-hidden="true" />
        {tabs.map((tab, index) => {
          const TabIcon = tab.icon;
          const active = tab.id === selected;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={active ? "settings-tab is-active" : "settings-tab"}
              data-tab-id={tab.id}
              id={`${tabIdPrefix}-${tab.id}`}
              aria-label={tab.label}
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => select(tab.id)}
            >
              <span className="settings-tab-icon">
                <TabIcon size={19} weight={active ? "fill" : "regular"} aria-hidden="true" />
                {tab.alert && <span className="settings-tab-alert" aria-hidden="true" />}
              </span>
              <span className="settings-tab-label">
                <span className="settings-tab-label-text">{tab.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
