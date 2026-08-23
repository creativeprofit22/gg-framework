import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { appBuildInfo } from "./build-info";
import { theme } from "./theme";
import { Confetti } from "./Confetti";
import { ShimmerText } from "./ShimmerText";
import { Badge } from "./Badge";
import {
  availableWhatsNewFeeds,
  getWhatsNewStatus,
  markWhatsNewFeedSeen,
  type WhatsNewEntry,
  type WhatsNewFeedId,
  type WhatsNewStatus,
} from "./whats-new";

/**
 * Body of the dedicated, screen-centered "What's new" window built by Rust
 * `open_whatsnew_window` and reached through `?whatsnew=1` in main.tsx.
 * Renders one capped feed at a time. Escape, ×, and "Got it" close the window.
 */
const HIGHLIGHT_TERMS = [
  "MiMo-V2.5-Pro-UltraSpeed",
  "GPT-5.6 Ultra",
  "GPT-5.6",
  "GPT-5.5",
  "GPT-5.4 Mini",
  "GPT-5.4",
  "GPT-5.3 Codex",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Claude Sonnet 5",
  "Claude Fable 5",
  "Sakana Fugu",
  "Fugu Ultra",
  "Radio Paradise",
  "Kencode search",
  "Prompt Enhancer",
  "Send to Supah Coder",
  "Grant Permissions",
  "Autopilot",
  "Scorecard",
  "Enhance",
  "@Supah",
  "Radio",
  "Windows",
  "Notes",
  "MCP",
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const highlightPattern = new RegExp(
  `\`([^\`]+)\`|(${HIGHLIGHT_TERMS.map(escapeRegex).join("|")})|\\b(\\d+(?:\\.\\d+)?(?:K|M| MB| tokens?| minutes?| hour| updates?))\\b`,
  "g",
);

export function releaseText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(highlightPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const value = match[1] ?? match[2] ?? match[3] ?? match[0];
    nodes.push(
      <strong className="whatsnew-highlight" key={`${index}-${value}`}>
        {value}
      </strong>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function closeSelf(): void {
  void getCurrentWebviewWindow()
    .close()
    .catch(() => {});
}

interface WhatsNewWindowProps {
  localPatched?: boolean;
  storage?: Storage;
}

function ReleaseFeed({ entries }: { entries: WhatsNewEntry[] }): React.ReactElement {
  if (entries.length === 0) {
    return <p className="whatsnew-empty">No release notes yet.</p>;
  }
  return (
    <>
      {entries.map((section, sectionIndex) => (
        <section
          key={section.id}
          className={`whatsnew-section${sectionIndex === 0 ? " latest" : ""}`}
        >
          {sectionIndex === 1 && (
            <div className="whatsnew-history-divider">
              <span>Previous updates</span>
            </div>
          )}
          <div className="whatsnew-version">
            <span>{section.label}</span>
            <time dateTime={section.date}>{section.date}</time>
            {sectionIndex === 0 && <Badge>Latest</Badge>}
          </div>
          <ul className="whatsnew-list">
            {section.items.map((item, index) => (
              <li key={`${section.id}-${index}`} className="whatsnew-item">
                {releaseText(item)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function initialStatus(localPatched: boolean, storage?: Storage): WhatsNewStatus {
  if (storage) return getWhatsNewStatus(storage, localPatched);
  return { feeds: availableWhatsNewFeeds(localPatched), seenHeads: {}, unreadFeedIds: [] };
}

function tabId(id: WhatsNewFeedId): string {
  return `whatsnew-tab-${id}`;
}

function panelId(id: WhatsNewFeedId): string {
  return `whatsnew-panel-${id}`;
}

export function WhatsNewWindow({
  localPatched = appBuildInfo.localPatched,
  storage = typeof localStorage === "undefined" ? undefined : localStorage,
}: WhatsNewWindowProps = {}): React.ReactElement {
  const [status] = useState(() => initialStatus(localPatched, storage));
  const [selectedFeedId, setSelectedFeedId] = useState<WhatsNewFeedId>(
    status.unreadFeedIds[0] ?? status.feeds[0]?.id ?? "upstream",
  );
  const [unreadFeedIds, setUnreadFeedIds] = useState(status.unreadFeedIds);
  const hasTabs = status.feeds.length > 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeSelf();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!storage) return;
    markWhatsNewFeedSeen(storage, localPatched, selectedFeedId);
    setUnreadFeedIds((current) => current.filter((id) => id !== selectedFeedId));
  }, [localPatched, selectedFeedId, storage]);

  function selectTabFromKey(event: React.KeyboardEvent, currentIndex: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + status.feeds.length) % status.feeds.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % status.feeds.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = status.feeds.length - 1;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextFeed = status.feeds[nextIndex];
    setSelectedFeedId(nextFeed.id);
    document.getElementById(tabId(nextFeed.id))?.focus();
  }

  return (
    <div
      className={`whatsnew-window feed-${selectedFeedId}`}
      style={{ background: theme.surface2 }}
    >
      <Confetti />
      <div className="modal-head">
        <h1 className="modal-title">
          <ShimmerText base={theme.primary} bright={theme.secondary}>
            What&apos;s new with {PRODUCT_DISPLAY_NAME}
          </ShimmerText>
        </h1>
        <button
          className="modal-close"
          type="button"
          aria-label="Close"
          title="Close"
          onClick={closeSelf}
        >
          {"\u00d7"}
        </button>
      </div>
      {hasTabs ? (
        <div className="whatsnew-tabs" role="tablist" aria-label="What's new sources">
          {status.feeds.map((feed, index) => {
            const selected = feed.id === selectedFeedId;
            const unread = unreadFeedIds.includes(feed.id);
            return (
              <button
                id={tabId(feed.id)}
                key={feed.id}
                className={`whatsnew-tab feed-${feed.id}`}
                type="button"
                role="tab"
                aria-controls={panelId(feed.id)}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setSelectedFeedId(feed.id)}
                onKeyDown={(event) => selectTabFromKey(event, index)}
              >
                <span>{feed.label}</span>
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
        <div className="whatsnew-single-source">Upstream</div>
      )}
      <div className="whatsnew-scroll">
        {status.feeds.map((feed) => (
          <div
            id={panelId(feed.id)}
            key={feed.id}
            className={`whatsnew-panel feed-${feed.id}`}
            role={hasTabs ? "tabpanel" : undefined}
            aria-labelledby={hasTabs ? tabId(feed.id) : undefined}
            hidden={feed.id !== selectedFeedId}
          >
            <ReleaseFeed entries={feed.entries} />
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="modal-btn primary" type="button" onClick={closeSelf}>
          Got it
        </button>
      </div>
    </div>
  );
}
