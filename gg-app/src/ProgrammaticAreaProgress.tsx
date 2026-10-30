import { useRef, useState } from "react";
import type { ProgrammaticAreaProgress as AreaRow } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { ProgrammaticChatRequest } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type { ProgrammaticChatState } from "./programmatic-chat-state";
import type { AreaProgressState } from "./programmatic-discovery-state";
import {
  AREA_PROGRESS as copy,
  AREA_RESULT_WORDS,
  AREA_STATUS_ICONS,
  areaAnnouncement,
  areaStatusWord,
} from "./programmatic-presentation";

const FINISHED = new Set<AreaRow["status"]>(["found", "partly", "failed"]);

/** Text for the polite region: only areas that just finished, the merge start and the stop. */
function announcement(previous: AreaProgressState | null, next: AreaProgressState | null) {
  if (!next) return null;
  const before = previous?.sequence === next.sequence ? previous : null;
  const old = new Map(before?.areas.map((area) => [area.id, area.status]));
  const parts: string[] = [];
  for (const area of next.areas) {
    const was = old.get(area.id);
    if (FINISHED.has(area.status) && !(was && FINISHED.has(was))) {
      const text = areaAnnouncement(area);
      if (text) parts.push(text);
    }
  }
  const stopped = (rows: readonly AreaRow[] | undefined) =>
    !!rows?.some((area) => area.status === "stopped");
  if (stopped(next.areas) && !stopped(before?.areas)) parts.push(copy.stopped);
  if (next.stage === "merging" && before?.stage !== "merging") parts.push(copy.merging);
  return parts.length ? parts.join(". ") : null;
}

interface Row {
  id: string;
  label: string;
  icon: string;
  word: string;
}

/** Step 2's area list: live rows while searching, then the final rows with one-area retry. */
export function ProgrammaticAreaProgress({
  state,
  locked,
  planMode,
  onRequest,
  onStop,
}: {
  state: ProgrammaticChatState;
  locked: boolean;
  planMode: boolean;
  onRequest(request: ProgrammaticChatRequest): void;
  onStop?(): void;
}): React.ReactElement | null {
  const intro = useRef<HTMLParagraphElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const progress = state.areaProgress;
  const [seen, setSeen] = useState(progress);
  const [message, setMessage] = useState("");
  if (seen !== progress) {
    setSeen(progress);
    const next = announcement(seen, progress);
    if (next) setMessage(next);
  }
  const assessment = state.assessmentPending ? null : state.assessment;
  const sequence = assessment?.lifecycle?.sequence;
  const refused = state.error === copy.retryRefused;
  const retryable = new Set(
    sequence !== undefined && !refused
      ? (assessment?.areas ?? [])
          .filter((area) => area.retryable && area.status === "not-searched")
          .map((area) => area.id)
      : [],
  );
  const live =
    progress &&
    (state.assessmentPending ||
      (sequence !== undefined && progress.sequence === sequence) ||
      (!assessment && progress.sequence === state.assessmentSequence));
  const rows: Row[] = live
    ? progress.areas.map((area) => ({
        id: area.id,
        label: area.label,
        icon: AREA_STATUS_ICONS[area.status],
        word: areaStatusWord(area),
      }))
    : (assessment?.areas ?? []).map((area) => ({
        id: area.id,
        label: area.label,
        icon: area.status === "not-searched" ? AREA_STATUS_ICONS.failed : AREA_STATUS_ICONS.found,
        word: AREA_RESULT_WORDS[area.status],
      }));
  if (!rows.length && !state.assessmentPending) return null;
  return (
    <div className="opp-areas">
      <p className="opp-caption opp-areas-intro" ref={intro} tabIndex={-1}>
        {copy.listLabel}
      </p>
      {rows.length > 0 && (
        <ol
          className="opp-area-list"
          aria-label={copy.listLabel}
          aria-busy={state.assessmentPending || undefined}
        >
          {rows.map((row) => (
            <li
              key={row.id}
              className="opp-area inst-module"
              tabIndex={-1}
              ref={(node) => {
                if (node) rowRefs.current.set(row.id, node);
                else rowRefs.current.delete(row.id);
              }}
            >
              <span className="opp-area-icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="opp-area-label">{row.label}</span>
              <span className="opp-area-word">{row.word}</span>
              {retryable.has(row.id) && sequence !== undefined && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm opp-area-retry"
                  aria-label={copy.retryName(row.label)}
                  disabled={locked || planMode}
                  onClick={() => {
                    rowRefs.current.get(row.id)?.focus();
                    onRequest({
                      version: 1,
                      action: "discover",
                      retryArea: { sequence, areaId: row.id },
                    });
                  }}
                >
                  {copy.retry}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {state.assessmentPending && progress?.stage === "merging" && (
        <p className="opp-caption opp-areas-merge">{copy.merging}</p>
      )}
      {refused && (
        <p className="opp-notice" data-tone="warning" role="alert">
          {copy.retryRefused}
        </p>
      )}
      {state.assessmentPending && onStop && (
        <div className="programmatic-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              intro.current?.focus();
              onStop();
            }}
          >
            {copy.stop}
          </button>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
    </div>
  );
}
