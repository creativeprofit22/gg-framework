import { useEffect, useState } from "react";
import { TrashIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import {
  waitForReady,
  listGoals,
  deleteGoal,
  focusWindowByOffset,
  arrangeAllWindows,
  type GoalSummary,
} from "./agent";
import { Badge } from "./Badge";
import { ListSkeleton } from "./Skeleton";
import { useCachedList } from "./useCachedList";
import { BackButton } from "./BackButton";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { RadioButton } from "./RadioButton";
import { NewGoalModal } from "./NewGoalModal";
import { ConfirmModal } from "./ConfirmModal";

interface Props {
  /**
   * Point this pane at a goal's coordinator. Injected so a split window opens
   * the goal in the pane that showed the picker, not the primary pane.
   */
  openGoal: (cwd: string, sessionPath?: string) => Promise<unknown>;
  /** Called after this pane has been pointed at the goal's coordinator. */
  onChosen: (cwd: string) => void;
  /** Back to Home. */
  onClose?: () => void;
}

/** "2 folders · 1 file" style summary of a goal's attached context. */
export function contextSummary(goal: GoalSummary): string | null {
  const folders = goal.context.filter((c) => c.kind === "folder").length;
  const files = goal.context.length - folders;
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} ${folders === 1 ? "folder" : "folders"}`);
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  return parts.length > 0 ? parts.join(" \u00b7 ") : null;
}

/**
 * Full-window Goal chooser, the Goals counterpart of ProjectPicker. A goal is
 * one ongoing conversation, so choosing a row reopens its latest session
 * directly instead of listing sessions.
 */
/** How often the open goal list refreshes each goal's status. */
const GOAL_STATUS_REFRESH_MS = 4000;

/**
 * A goal's state on its row, only when it's worth a glance: "Running now"
 * (breathing, in the success colour) while it works, "Paused" when the user
 * paused it, "Interrupted" (warning colour) when it was cut off mid-work.
 * Briefing and finished goals carry no pill, so the pill always means
 * something.
 */
function GoalStatusPill({ status }: { status: GoalSummary["status"] }): React.ReactElement | null {
  if (status === "running") {
    return (
      <Badge
        className="goal-status-running"
        color="var(--success)"
        title="GG Goals is working on this now"
      >
        Running now
      </Badge>
    );
  }
  if (status === "paused") {
    return <Badge title="Paused. Open it and press play to carry on">Paused</Badge>;
  }
  if (status === "interrupted") {
    return (
      <Badge color="var(--warning)" title="Stopped mid-work. Opening it carries it on">
        Interrupted
      </Badge>
    );
  }
  return null;
}

export function GoalPicker({ openGoal, onChosen, onClose }: Props): React.ReactElement {
  // Shown at once on a return visit, refreshed quietly (see useCachedList).
  const goalList = useCachedList<GoalSummary>("goals", async () => {
    await waitForReady();
    return listGoals();
  });
  const { items: goals, loading, setItems: setGoalsWith } = goalList;
  const loadError = goalList.error !== null;
  const setGoals = (next: GoalSummary[] | ((prev: GoalSummary[]) => GoalSummary[])): void =>
    setGoalsWith((prev) => (typeof next === "function" ? next(prev) : next));
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<GoalSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const q = query.trim().toLowerCase();
  const filteredGoals = q
    ? goals.filter((g) => g.name.toLowerCase().includes(q) || g.goal.toLowerCase().includes(q))
    : goals;

  // Same multi-window shortcuts as the project picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.code === "Backquote" && !e.altKey) {
        e.preventDefault();
        void focusWindowByOffset(e.shiftKey ? -1 : 1);
      } else if (e.shiftKey && (e.key === "a" || e.key === "A") && !e.altKey) {
        e.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Goals keep working while the list is open: refresh their status quietly
  // (no loading state), so "Running now" and "Paused" stay true.
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      void listGoals()
        .then((g) => {
          if (!cancelled) setGoalsWith(() => g);
        })
        .catch(() => undefined);
    }, GOAL_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [setGoalsWith]);

  function choose(goal: GoalSummary): void {
    if (busy) return;
    setBusy(true);
    setOpenError(null);
    void openGoal(goal.path, goal.latestSessionPath ?? undefined)
      .then(() => onChosen(goal.path))
      .catch((reason: unknown) => {
        setOpenError(reason instanceof Error ? reason.message : String(reason));
        setBusy(false);
      });
  }

  function confirmDelete(): void {
    const goal = pendingDelete;
    if (!goal || deleting) return;
    setDeleting(true);
    setOpenError(null);
    void deleteGoal(goal.id)
      .then(() => setGoals((prev) => prev.filter((g) => g.id !== goal.id)))
      .catch((reason: unknown) =>
        setOpenError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => {
        setDeleting(false);
        setPendingDelete(null);
      });
  }

  const newGoalButton = (
    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setShowNew(true)}>
      {"+ New goal"}
    </button>
  );

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        {onClose && <BackButton label="Back" onClick={onClose} />}
        <span className="picker-title">Choose a goal</span>
        {!loading && !loadError && <Badge>{goals.length}</Badge>}
        {!loading && goals.length > 0 && (
          <input
            className="picker-search"
            type="text"
            placeholder={"Search goals\u2026"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search goals"
          />
        )}
        <span className="picker-head-actions">
          {newGoalButton}
          <RadioButton />
          <WindowLayoutButton />
        </span>
      </div>

      <div className="picker-list">
        {openError && (
          <div className="picker-error" role="alert">
            {openError}
          </div>
        )}
        {loading && <ListSkeleton rows={6} />}
        {!loading && loadError && (
          <div className="picker-empty" role="alert">
            <span style={{ color: theme.textMuted }}>Couldn't load your goals.</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={goalList.reload}>
              Try again
            </button>
          </div>
        )}
        {!loading && !loadError && goals.length === 0 && (
          <div className="picker-empty">
            <span style={{ color: theme.textMuted }}>
              No goals yet. Give GG Coder something bigger than one session.
            </span>
            {newGoalButton}
          </div>
        )}
        {!loading && goals.length > 0 && filteredGoals.length === 0 && (
          <div className="picker-empty" style={{ color: theme.textMuted }}>
            {`No goals match \u201c${query.trim()}\u201d`}
          </div>
        )}
        {!loading && filteredGoals.length > 0 && (
          <div className="picker-reveal">
            {filteredGoals.map((g) => {
              const context = contextSummary(g);
              return (
                <div key={g.path} className="picker-item-wrap">
                  <button
                    className="picker-item goal-item"
                    disabled={busy}
                    onClick={() => choose(g)}
                  >
                    <span className="picker-row">
                      <span className="goal-title">
                        <span className="picker-name" style={{ color: theme.text }}>
                          {g.name}
                        </span>
                        {context && <Badge>{context}</Badge>}
                        <GoalStatusPill status={g.status} />
                      </span>
                      <Badge>{g.lastActiveDisplay}</Badge>
                    </span>
                    <span className="picker-meta goal-meta">
                      <span className="picker-preview goal-preview">{g.goal}</span>
                    </span>
                  </button>
                  <button
                    className="picker-hide"
                    aria-label={`Delete ${g.name}`}
                    title="Delete goal"
                    disabled={busy || deleting}
                    onClick={() => setPendingDelete(g)}
                  >
                    <TrashIcon size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmModal
          title="Delete goal"
          message={`Delete \u201c${pendingDelete.name}\u201d and its conversation? Your attached folders and files are not touched. This can\u2019t be undone.`}
          confirmLabel="Delete"
          busy={deleting}
          onConfirm={confirmDelete}
          onClose={() => {
            if (!deleting) setPendingDelete(null);
          }}
        />
      )}
      {showNew && (
        <NewGoalModal
          openGoal={openGoal}
          onClose={() => setShowNew(false)}
          onCreated={(goal) => {
            setShowNew(false);
            onChosen(goal.path);
          }}
        />
      )}
    </div>
  );
}
