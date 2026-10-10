import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { getChecklist, subscribe } from "./agent";
import type { ChecklistLoad, ChecklistNotice } from "./ChecklistScreen";
import { withViewTransition } from "./view-transition";

/** Checklist view data: load state, the in-flight run, and refresh-on-run_end. Extracted from App.tsx. */
export function useChecklist({
  showChecklist,
  setShowChecklist,
  inputRef,
}: {
  showChecklist: boolean;
  setShowChecklist: Dispatch<SetStateAction<boolean>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [checklistLoad, setChecklistLoad] = useState<ChecklistLoad>({ kind: "loading" });
  const [checklistRunId, setChecklistRunId] = useState<string | null>(null);
  const [checklistNotice, setChecklistNotice] = useState<ChecklistNotice | null>(null);
  const checklistRunRef = useRef<{
    id: string;
    checkedAt: string | null;
    expectsRecord: boolean;
  } | null>(null);
  const checklistFetchRef = useRef(0);
  const checklistWasOpen = useRef(false);
  const refreshChecklist = useCallback(
    async (completed?: {
      id: string;
      checkedAt: string | null;
      expectsRecord: boolean;
    }): Promise<void> => {
      const fetchId = ++checklistFetchRef.current;
      const snapshot = await getChecklist();
      if (fetchId !== checklistFetchRef.current) return;
      setChecklistLoad(snapshot ? { kind: "ready", snapshot } : { kind: "error" });
      if (snapshot) {
        setChecklistNotice((previous) => {
          const notice = completed?.expectsRecord
            ? {
                id: completed.id,
                checkedAt: completed.checkedAt,
                message: "No result recorded. View the conversation for details.",
              }
            : previous;
          if (!notice) return null;
          const checkedAt = snapshot.items.find((item) => item.id === notice.id)?.checkedAt;
          return checkedAt && checkedAt !== notice.checkedAt ? null : notice;
        });
      }
    },
    [],
  );
  const openChecklist = useCallback(() => {
    withViewTransition(() => {
      setShowChecklist(true);
      setChecklistLoad({ kind: "loading" });
      void refreshChecklist();
    });
  }, [refreshChecklist, setShowChecklist]);
  useEffect(() => {
    if (!showChecklist && checklistWasOpen.current)
      inputRef.current?.focus({ preventScroll: true });
    checklistWasOpen.current = showChecklist;
  }, [showChecklist, inputRef]);
  // Refresh from the record, not from an assistant's claim of success. This also
  // picks up checks recorded during ordinary chat while this view is open.
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== "run_end") return;
        const completed = checklistRunRef.current;
        checklistRunRef.current = null;
        setChecklistRunId(null);
        if (showChecklist || completed) void refreshChecklist(completed ?? undefined);
      }),
    [showChecklist, refreshChecklist],
  );
  useEffect(
    () => () => {
      checklistFetchRef.current++;
      checklistRunRef.current = null;
    },
    [],
  );

  return {
    checklistLoad,
    setChecklistLoad,
    checklistRunId,
    setChecklistRunId,
    checklistNotice,
    setChecklistNotice,
    checklistRunRef,
    checklistFetchRef,
    openChecklist,
    refreshChecklist,
  };
}
