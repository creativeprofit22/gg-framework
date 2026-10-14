import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { error as logError } from "@tauri-apps/plugin-log";
import { XIcon } from "@phosphor-icons/react";
import { createSafeTauriUnlisten, type SafeTauriUnlisten } from "./tauri-listener";
import { appBuildInfo } from "./build-info";
import { Badge } from "./Badge";
import { recentChangelog } from "./changelog";
import { revealWhatsNewWindow, type VerifiedDecisionRecord } from "./agent";
import {
  getWhatsNewStatus,
  markWhatsNewFeedSeen,
  type WhatsNewFeedId,
  type WhatsNewStatus,
} from "./whats-new-status";
import { availableWhatsNewFeeds, type WhatsNewEntry } from "./whats-new";
import { shortDate, type WhatsNewMode } from "./whatsnew-content";
import { CampfireStories, WhatsNewCampfire } from "./WhatsNewCampfire";
import { releaseText } from "./WhatsNewParts";
import "./WhatsNew.css";

export { releaseText } from "./WhatsNewParts";

/**
 * Body of the dedicated, screen-centered "What's new" window (the borderless
 * Tauri window built by Rust `open_whatsnew_window`, reached via the
 * `?whatsnew=1` flag in main.tsx). Two moods share one window:
 *   - `hype`: the one-time show right after an update relaunch.
 *   - `calm`: the same campfire, settled, for the home screen's button.
 * Local Fork builds add source tabs (Local Fork, Upstream, Decisions) under the
 * campfire banner; each tab's panel scrolls inside the same window.
 *
 * Opening: Rust builds the window hidden. Once this has rendered, it asks Rust
 * to show it (`reveal_whatsnew_window`; Rust closes a never-revealed window),
 * then fades the card in. Closing fades the card out before the window goes.
 */
type Phase = "hidden" | "open" | "closing";

/** Matches `.whatsnew-window[data-phase="closing"]` in WhatsNew.css. */
const CLOSE_MS = 160;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function closeWindow(): void {
  void getCurrentWebviewWindow()
    .close()
    .catch(() => {});
}

/** Local Fork / Decisions feeds: newest entry as stories, older ones as history. */
function ReleaseFeed({
  entries,
  rawDates = false,
}: {
  entries: WhatsNewEntry[];
  /** Decision records keep their exact ISO dates. */
  rawDates?: boolean;
}): React.ReactElement {
  const dateText = (date: string): string => (rawDates ? date : shortDate(date));
  const [latest, ...earlier] = entries;
  if (!latest) {
    return <p className="whatsnew-empty">No release notes yet.</p>;
  }
  return (
    <>
      <section className="whatsnew-section latest">
        <h2 className="wn-history-version whatsnew-version">
          <span>{latest.label}</span>
          <time dateTime={latest.date}>{dateText(latest.date)}</time>
          <Badge>Latest</Badge>
        </h2>
        <ol className="wn-camp-stories" aria-label={latest.label}>
          {latest.items.map((item, i) => (
            <li
              key={`${latest.id}-${i}`}
              className="wn-camp-story wn-rise whatsnew-item"
              style={{ "--d": `${i * 0.05}s` } as CSSProperties}
            >
              {/* Same two-column story layout as upstream's campfire: number, then copy. */}
              <span className="wn-camp-num" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              {/* One element per note keeps the exact copy readable and matchable. */}
              <p className="wn-body">{releaseText(item)}</p>
            </li>
          ))}
        </ol>
      </section>
      {earlier.length > 0 && (
        <section className="wn-history wn-rise" aria-label="Previous updates">
          <h2 className="wn-history-title">
            <span>Previous updates</span>
          </h2>
          {earlier.map((section) => (
            <div className="wn-history-release whatsnew-section" key={section.id}>
              <h3 className="wn-history-version">
                <span>{section.label}</span>
                <time dateTime={section.date}>{dateText(section.date)}</time>
              </h3>
              <ul className="wn-history-list">
                {section.items.map((item, i) => (
                  <li key={`${section.id}-${i}`} className="wn-history-item whatsnew-item">
                    <p className="wn-body">{releaseText(item)}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

const HISTORICAL_DECISION_COPY =
  "New reliability fixes, same Local Fork. Your workspace, Roadmap, and session recovery stay in place while upstream improvements come in. No need to trade away your setup.";

function decisionEntries(records: VerifiedDecisionRecord[]): WhatsNewEntry[] {
  return records.map((record) => ({
    id: record.id,
    label: "Protected update",
    date: record.date,
    items: [
      record.id === "decision-89af62bbd76e" && record.summary.source === "fallback"
        ? HISTORICAL_DECISION_COPY
        : record.summary.text,
    ],
  }));
}

async function loadVerifiedDecisions(sourceRoot: string): Promise<VerifiedDecisionRecord[]> {
  return (await import("./agent")).getVerifiedDecisions(sourceRoot);
}

type DecisionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; records: VerifiedDecisionRecord[] };

function DecisionsFeed({
  state,
  retry,
}: {
  state: DecisionsState;
  retry: () => void;
}): React.ReactElement {
  if (state.status === "loading") {
    return (
      <p className="whatsnew-empty" role="status">
        Loading verified decisions…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <p className="whatsnew-empty" role="alert">
          We couldn’t load verified decisions. Please try again.
        </p>
        <button className="modal-btn" type="button" onClick={retry}>
          Retry
        </button>
      </>
    );
  }
  if (state.records.length === 0) {
    return <p className="whatsnew-empty">No verified decisions yet.</p>;
  }
  return <ReleaseFeed entries={decisionEntries(state.records)} rawDates />;
}

function initialStatus(localPatched: boolean, storage?: Storage) {
  const status: Pick<WhatsNewStatus, "seenHeads" | "unreadFeedIds"> = storage
    ? getWhatsNewStatus(storage, localPatched)
    : { seenHeads: {}, unreadFeedIds: [] };
  return { ...status, feeds: availableWhatsNewFeeds(localPatched) };
}

type WhatsNewTabId = WhatsNewFeedId | "decisions";

function tabId(id: WhatsNewTabId): string {
  return `whatsnew-tab-${id}`;
}

function panelId(id: WhatsNewTabId): string {
  return `whatsnew-panel-${id}`;
}

interface WhatsNewWindowProps {
  mode?: WhatsNewMode;
  /** Picks this opening's critters; injectable for tests. */
  random?: () => number;
  localPatched?: boolean;
  sourceRoot?: string;
  storage?: Storage;
  loadDecisions?: (repoRoot: string) => Promise<VerifiedDecisionRecord[]>;
}

export function WhatsNewWindow({
  mode = "calm",
  random = Math.random,
  localPatched = appBuildInfo.localPatched,
  sourceRoot = appBuildInfo.sourceRoot,
  storage = typeof localStorage === "undefined" ? undefined : localStorage,
  loadDecisions = loadVerifiedDecisions,
}: WhatsNewWindowProps = {}): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>("hidden");
  const closing = useRef(false);
  const [status] = useState(() => initialStatus(localPatched, storage));
  const [decisions, setDecisions] = useState<DecisionsState>({ status: "loading" });
  const [decisionsAttempt, setDecisionsAttempt] = useState(0);
  const tabs: Array<{ id: WhatsNewTabId; label: string }> = [
    ...status.feeds.map(({ id, label }) => ({ id, label })),
    ...(localPatched ? [{ id: "decisions" as const, label: "Decisions" }] : []),
  ];
  const [selectedFeedId, setSelectedFeedId] = useState<WhatsNewTabId>(
    status.unreadFeedIds[0] ?? status.feeds[0]?.id ?? "upstream",
  );
  const [unreadFeedIds, setUnreadFeedIds] = useState(status.unreadFeedIds);
  const hasTabs = tabs.length > 1;

  // Effects run once React has committed the first frame, so the window is
  // shown with that frame already in it; then the card fades in. No timer:
  // a hidden window's timers can be throttled to once a second.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await revealWhatsNewWindow();
      } catch (e) {
        await logError(`reveal_whatsnew_window failed: ${String(e)}`);
      }
      if (!cancelled) setPhase((current) => (current === "hidden" ? "open" : current));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback((): void => {
    if (closing.current) return;
    closing.current = true;
    if (prefersReducedMotion()) {
      closeWindow();
      return;
    }
    setPhase("closing");
    window.setTimeout(closeWindow, CLOSE_MS);
  }, []);

  // Escape closes the window (the borderless window has no native chrome).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (!storage || selectedFeedId === "decisions") return;
    markWhatsNewFeedSeen(storage, localPatched, selectedFeedId);
    setUnreadFeedIds((current) => current.filter((id) => id !== selectedFeedId));
  }, [localPatched, selectedFeedId, storage]);

  useEffect(() => {
    if (!localPatched) return;
    let active = true;
    let request = 0;
    let unlisten: SafeTauriUnlisten | undefined;
    async function load(): Promise<void> {
      if (!active) return;
      const currentRequest = ++request;
      setDecisions({ status: "loading" });
      try {
        const records = await loadDecisions(sourceRoot);
        if (active && currentRequest === request) setDecisions({ status: "loaded", records });
      } catch {
        if (active && currentRequest === request) setDecisions({ status: "error" });
      }
    }
    // Refocus also catches source-only CLI updates, which emit no desktop update event.
    void getCurrentWebviewWindow()
      .listen("tauri://focus", () => void load())
      .then((off) => {
        const stop = createSafeTauriUnlisten(off, "whatsnew-focus");
        if (active) unlisten = stop;
        else void stop();
      })
      .catch(() => {});
    void load();
    return () => {
      active = false;
      void unlisten?.();
    };
  }, [decisionsAttempt, loadDecisions, localPatched, sourceRoot]);

  function selectTabFromKey(event: React.KeyboardEvent, currentIndex: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setSelectedFeedId(nextTab.id);
    document.getElementById(tabId(nextTab.id))?.focus();
  }

  const [latest, ...earlier] = recentChangelog(50);
  if (!latest) return null;
  const hype = mode === "hype";

  const tablist = hasTabs ? (
    <div className="whatsnew-tabs" role="tablist" aria-label="What's new sources">
      {tabs.map((tab, index) => {
        const selected = tab.id === selectedFeedId;
        const unread = tab.id !== "decisions" && unreadFeedIds.includes(tab.id);
        return (
          <button
            id={tabId(tab.id)}
            key={tab.id}
            className={`whatsnew-tab feed-${tab.id}`}
            type="button"
            role="tab"
            aria-controls={panelId(tab.id)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setSelectedFeedId(tab.id)}
            onKeyDown={(event) => selectTabFromKey(event, index)}
          >
            <span>{tab.label}</span>
            {unread && (
              <>
                <span className="whatsnew-unread-dot" aria-hidden="true" />
                <span className="visually-hidden">, unread</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  ) : (
    // Official builds have a single source; still name it.
    <p className="whatsnew-source">{tabs[0]?.label ?? "Upstream"}</p>
  );

  // Upstream keeps the campfire's own stories; Local Fork and Decisions reuse
  // the same story/history parts inside their tab panels.
  const panels = hasTabs ? (
    <>
      {status.feeds.map((feed) => (
        <div
          id={panelId(feed.id)}
          key={feed.id}
          className={`whatsnew-panel feed-${feed.id}`}
          role="tabpanel"
          aria-labelledby={tabId(feed.id)}
          hidden={feed.id !== selectedFeedId}
        >
          {feed.id === "upstream" ? (
            <CampfireStories latest={latest} earlier={earlier} hype={hype} />
          ) : (
            <ReleaseFeed entries={feed.entries} />
          )}
        </div>
      ))}
      {localPatched && (
        <div
          id={panelId("decisions")}
          className="whatsnew-panel feed-decisions"
          role="tabpanel"
          aria-labelledby={tabId("decisions")}
          hidden={selectedFeedId !== "decisions"}
        >
          <DecisionsFeed
            state={decisions}
            retry={() => setDecisionsAttempt((attempt) => attempt + 1)}
          />
        </div>
      )}
    </>
  ) : undefined;

  return (
    <div className={`whatsnew-window feed-${selectedFeedId}`} data-mode={mode} data-phase={phase}>
      <WhatsNewCampfire
        latest={latest}
        earlier={earlier}
        mode={mode}
        random={random}
        onClose={close}
        tabs={tablist}
        panels={panels}
      />
      <button
        className="modal-close wn-close"
        type="button"
        aria-label="Close"
        title="Close"
        onClick={close}
      >
        <XIcon size={14} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
