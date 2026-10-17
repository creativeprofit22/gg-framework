interface Props {
  /** The reader has scrolled up, so the chat no longer follows new output. */
  away: boolean;
  /** New rows arrived below while the reader was scrolled up. */
  hasNew: boolean;
  /**
   * Where a question still waiting on the user sits, when it is off screen:
   * above the view (the agent kept talking after asking it) or below it (the
   * reader scrolled up past it). Null when there is none, or it is on screen.
   */
  askAt: "above" | "below" | null;
  onScrollToBottom: () => void;
  onJumpToNew: () => void;
  onJumpToAsk: () => void;
}

/**
 * The transcript's floating way around: a pill centred along the bottom edge
 * and a scroll-to-bottom button in the bottom-right corner. Both float over the
 * chat viewport (anchored to `.transcript-frame`, like the export pill).
 *
 * The centre pill says the most useful thing first: an unanswered question out
 * of view ("You have a new question", which the agent is blocked on) wins over
 * "You have new chats", which only shows while scrolled up.
 *
 * Always mounted so the exit fade can play; hidden ones leave the tab order
 * and the accessibility tree, matching `pointer-events: none`.
 */
export function TranscriptJumpControls({
  away,
  hasNew,
  askAt,
  onScrollToBottom,
  onJumpToNew,
  onJumpToAsk,
}: Props): React.ReactElement {
  const showAsk = askAt !== null;
  const showNew = !showAsk && away && hasNew;
  return (
    <>
      <button
        type="button"
        className={`transcript-new-pill transcript-ask-pill${showAsk ? " visible" : ""}`}
        onClick={onJumpToAsk}
        aria-hidden={!showAsk}
        tabIndex={showAsk ? 0 : -1}
      >
        {askAt === "below" ? <ArrowDown /> : <ArrowUp />}
        <span>You have a new question</span>
      </button>
      <button
        type="button"
        className={`transcript-new-pill${showNew ? " visible" : ""}`}
        onClick={onJumpToNew}
        aria-hidden={!showNew}
        tabIndex={showNew ? 0 : -1}
      >
        <ArrowDown />
        <span>You have new chats</span>
      </button>
      <button
        type="button"
        className={`transcript-to-bottom${away ? " visible" : ""}`}
        onClick={onScrollToBottom}
        aria-hidden={!away}
        tabIndex={away ? 0 : -1}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <ArrowDown />
      </button>
    </>
  );
}

function ArrowDown(): React.ReactElement {
  return (
    <Arrow>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </Arrow>
  );
}

function ArrowUp(): React.ReactElement {
  return (
    <Arrow>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </Arrow>
  );
}

function Arrow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {children}
    </svg>
  );
}
