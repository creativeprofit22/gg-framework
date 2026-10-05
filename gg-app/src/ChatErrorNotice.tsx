import { useEffect, useId, useState, type ReactNode } from "react";
import { ErrorCritter } from "./ErrorCritter";
import { usePresenceList } from "./usePresenceList";
import { chatErrorCopy, chatErrorTone, type ChatErrorData } from "./chat-error";
import "./ChatErrorNotice.css";

// Matches --dur-dissolve; retain the details until their exit has finished.
const DETAILS_EXIT_MS = 340;
const OPEN_DETAILS = ["details"] as const;
const CLOSED_DETAILS = [] as const;

export function ChatErrorNotice({
  error,
  critterId,
  active,
  modelPicker,
  onContentGrow,
}: {
  error: ChatErrorData;
  /** Chosen per row by assignErrorCritters. */
  critterId: string;
  active: boolean;
  modelPicker?: ReactNode;
  onContentGrow?: (() => void) | undefined;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const details = usePresenceList(
    expanded ? OPEN_DETAILS : CLOSED_DETAILS,
    (key) => key,
    DETAILS_EXIT_MS,
  );
  const detailsLeaving = details[0]?.leaving ?? false;
  const [motion, setMotion] = useState(true);
  const [now, setNow] = useState(Date.now);
  const detailsId = useId();
  const tone = chatErrorTone(error, active);
  const copy = chatErrorCopy(error, active, now);
  const canChooseModel =
    active &&
    !error.historical &&
    error.reason != null &&
    ["usage_limit", "model_access", "capability", "update"].includes(error.reason);

  // Only the current plan-limit row owns a single deadline timer, never a polling loop.
  useEffect(() => {
    if (!active || error.historical || error.reason !== "usage_limit" || error.resetsAt == null)
      return;
    const current = Date.now();
    setNow(current);
    const delay = error.resetsAt * 1000 - current;
    if (delay <= 0 || delay > 2_147_483_646) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay + 1);
    return () => window.clearTimeout(timer);
  }, [active, error.historical, error.reason, error.resetsAt]);

  useEffect(() => {
    if (expanded) onContentGrow?.();
  }, [expanded, onContentGrow]);

  return (
    <div className={`chat-error-notice chat-error-${tone}`}>
      <ErrorCritter critterId={critterId} animate={tone !== "history" && motion} />
      <div
        className="chat-error-copy"
        role={active ? "status" : undefined}
        aria-atomic={active ? true : undefined}
      >
        <div className="chat-error-heading">
          <div className="chat-error-headline">{copy.headline}</div>
          <button
            type="button"
            className="chat-error-details-toggle"
            aria-label={expanded ? "Hide error details" : "Show error details"}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            Details
          </button>
        </div>
        <div className="chat-error-recovery">
          <span>{copy.guidance}</span>
          {canChooseModel && modelPicker}
        </div>
      </div>
      <div
        id={detailsId}
        className={`chat-error-details${detailsLeaving ? " leaving" : " dissolve-in"}`}
        hidden={details.length === 0}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        {!error.reason && error.headline && <p>{error.headline}</p>}
        {error.message || error.text ? (
          <p>{error.message ?? error.text}</p>
        ) : (
          <p>No additional detail was supplied.</p>
        )}
        {(tone === "history" || !error.reason) && error.guidance && <p>{error.guidance}</p>}
        {copy.resetLabel && <p>{copy.resetLabel}</p>}
        {error.provider && <p>Provider: {error.provider}</p>}
        {error.statusCode != null && <p>HTTP status: {error.statusCode}</p>}
        {error.requestId && <p>Request: {error.requestId}</p>}
        {error.occurredAt != null && <p>Reported: {new Date(error.occurredAt).toLocaleString()}</p>}
        {tone !== "history" && (
          <button
            type="button"
            className="chat-error-motion"
            aria-pressed={!motion}
            onClick={() => setMotion((value) => !value)}
          >
            {motion ? "Pause critter animation" : "Resume critter animation"}
          </button>
        )}
      </div>
    </div>
  );
}
