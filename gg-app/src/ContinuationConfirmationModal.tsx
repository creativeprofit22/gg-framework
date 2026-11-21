import type { Dispatch, RefObject, SetStateAction } from "react";
import { ConfirmModal } from "./ConfirmModal";

export interface ContinuationConfirmationState {
  prompt: string;
  profile: "stable" | "experimental" | null;
  busy: boolean;
  error?: string;
  retry?: boolean;
}

type ContinuationConfirmationResolver = (
  choice: { profile: "stable" | "experimental" | null } | null,
) => void;

/** Confirms a Ken-prepared continuation before it replaces the current conversation. */
export function ContinuationConfirmationModal({
  continuationConfirmation,
  setContinuationConfirmation,
  continuationConfirmationRef,
  commitPreparedContinuation,
}: {
  continuationConfirmation: ContinuationConfirmationState;
  setContinuationConfirmation: Dispatch<SetStateAction<ContinuationConfirmationState | null>>;
  continuationConfirmationRef: RefObject<ContinuationConfirmationResolver | null>;
  commitPreparedContinuation: () => Promise<unknown>;
}): React.ReactElement {
  return (
    <ConfirmModal
      title="Continue in a new session"
      className="continuation-confirmation"
      message={
        continuationConfirmation.error ??
        "Start a fresh conversation with this exact instruction and a continuation handoff? Your current conversation is saved in Sessions."
      }
      confirmLabel={
        continuationConfirmation.error
          ? continuationConfirmation.retry
            ? "Check outcome"
            : "Close"
          : "Continue"
      }
      busy={continuationConfirmation.busy}
      content={
        <>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: "35vh",
              overflow: "auto",
            }}
            aria-label="Selected continuation prompt"
          >
            {continuationConfirmation.prompt}
          </pre>
          {continuationConfirmation.profile !== null && (
            <label>
              Destination context mode
              <select
                aria-label="Destination context mode"
                value={continuationConfirmation.profile}
                disabled={continuationConfirmation.busy || !!continuationConfirmation.error}
                onChange={(event) => {
                  const profile = event.target.value;
                  if (profile === "stable" || profile === "experimental") {
                    setContinuationConfirmation((current) =>
                      current ? { ...current, profile } : current,
                    );
                  }
                }}
              >
                <option value="stable">Stable · 272K</option>
                <option value="experimental">Experimental · 872K</option>
              </select>
            </label>
          )}
        </>
      }
      onConfirm={() => {
        if (continuationConfirmation.error) {
          if (continuationConfirmation.retry) {
            void commitPreparedContinuation();
            return;
          }
          setContinuationConfirmation(null);
          return;
        }
        const resolve = continuationConfirmationRef.current;
        if (!resolve) return;
        continuationConfirmationRef.current = null;
        setContinuationConfirmation((current) => (current ? { ...current, busy: true } : current));
        resolve({ profile: continuationConfirmation.profile });
      }}
      onClose={() => {
        if (continuationConfirmation.busy) return;
        continuationConfirmationRef.current?.(null);
        continuationConfirmationRef.current = null;
        setContinuationConfirmation(null);
      }}
    />
  );
}
