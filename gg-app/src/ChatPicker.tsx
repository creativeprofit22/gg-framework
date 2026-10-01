import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { theme } from "./theme";
import {
  arrangeAllWindows,
  focusWindowByOffset,
  listSessions,
  readSettings as readAppSettings,
  selectWorkspace,
  waitForReady,
  type AppSettings,
  type ChatAgentId,
  type RecentSession,
} from "./agent";
import { motionWorkspacePath } from "./motion-workspace";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ListSkeleton } from "./Skeleton";
import { RadioButton } from "./RadioButton";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { MetalButton } from "./MetalButton";
import { useWindowFocused } from "./useWindowFocused";
import { describeActionFailure, describeOpenFailure, type FailureCopy } from "./open-failure";
import { PickerError } from "./PickerError";

interface Props {
  onChosen: (cwd: string) => void;
  onClose?: () => void;
  initialAgent?: ChatAgentId;
  /** Which non-coding workspace this picker opens. Defaults to chat. */
  mode?: "chat" | "motion";
  waitForCatalogReady?: () => Promise<unknown>;
  /** Reads app settings; must throw on failure so it isn't mistaken for "no folder chosen". */
  readSettings?: () => Promise<AppSettings>;
  discoverSessions?: (
    cwd: string,
    chatAgent?: ChatAgentId | "all" | "motion",
  ) => Promise<RecentSession[]>;
  bindChat?: (
    cwd: string,
    sessionPath: string | undefined,
    chatAgent: ChatAgentId,
  ) => Promise<unknown>;
  showWindowControls?: boolean;
}

const COPY = {
  chat: {
    title: "Chats",
    newLabel: "+ New chat",
    empty: "No previous chats yet.",
    noRoot: "Choose a projects folder in Settings before starting a chat.",
    loadAction: "load chats",
  },
  motion: {
    title: "Motion",
    newLabel: "+ New video",
    empty: "No motion sessions yet.",
    noRoot: "Choose a projects folder in Settings before starting a video.",
    loadAction: "load motion sessions",
  },
} as const;

/** Session chooser for Chat or Motion, rooted at the configured projects folder. */
export function ChatPicker({
  onChosen,
  onClose,
  initialAgent = "general",
  mode = "chat",
  waitForCatalogReady = waitForReady,
  readSettings = readAppSettings,
  discoverSessions = listSessions,
  bindChat = (cwd, sessionPath, chatAgent) => selectWorkspace(mode, cwd, sessionPath, chatAgent),
  showWindowControls = true,
}: Props): React.ReactElement {
  const copy = COPY[mode];
  const windowFocused = useWindowFocused();
  const [projectsRoot, setProjectsRoot] = useState("");
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureCopy | null>(null);
  // `retry` is data, not a closure, so Retry runs this render's `busy` guard.
  const [selectionError, setSelectionError] = useState<
    (FailureCopy & { retry: RecentSession | null }) | null
  >(null);
  const selectionErrorId = useId();
  // Only the latest load may write state; an older one finishing late is dropped.
  const loadSeq = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.code === "Backquote" && !event.altKey) {
        event.preventDefault();
        void focusWindowByOffset(event.shiftKey ? -1 : 1);
      } else if (event.shiftKey && (event.key === "a" || event.key === "A") && !event.altKey) {
        event.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Load (or reload after a failure) the session list under the projects root. */
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const current = (): boolean => seq === loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      // A failed read throws into the catch below; only a real empty root is "not configured".
      const settings = await readSettings();
      const projects = settings.projectsRoot.trim();
      if (!projects) {
        // Actionable as written: say what to do rather than "try again".
        if (current()) setError({ summary: copy.noRoot, detail: null });
        return;
      }
      const root = mode === "motion" ? motionWorkspacePath(projects) : projects;
      if (current()) setProjectsRoot(root);
      await waitForCatalogReady();
      const recent = await discoverSessions(root, mode === "motion" ? "motion" : "all");
      if (current()) setSessions(recent);
    } catch (reason: unknown) {
      if (current()) setError(describeActionFailure(copy.loadAction, reason));
    } finally {
      if (current()) setLoading(false);
    }
  }, [copy, mode, readSettings, discoverSessions, waitForCatalogReady]);

  useEffect(() => {
    void load();
    return () => {
      // Invalidate the in-flight load on unmount or dependency change.
      loadSeq.current += 1;
    };
  }, [load]);

  function choose(session?: RecentSession): void {
    if (busy || !projectsRoot) return;
    setBusy(true);
    setSelectionError(null);
    void bindChat(projectsRoot, session?.path, session?.chatAgent ?? initialAgent)
      .then(() => onChosen(projectsRoot))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setSelectionError({
          ...describeOpenFailure(message, session?.preview),
          retry: session ?? null,
        });
        setBusy(false);
      });
  }

  // A failed resume sits directly under its row; a failed new chat (no row) sits on top.
  const failedRowId = selectionError?.retry?.id;
  const failedRowShown =
    !loading && !error && failedRowId !== undefined && sessions.some((s) => s.id === failedRowId);
  const selectionErrorBlock = selectionError && (
    <PickerError
      id={selectionErrorId}
      summary={selectionError.summary}
      detail={selectionError.detail}
      retryDisabled={busy}
      onRetry={() => choose(selectionError.retry ?? undefined)}
    />
  );

  return (
    <div className="picker chat-picker">
      <div className="picker-head" data-tauri-drag-region>
        {/* The page's own controls share the list's column; window controls stay at the edge. */}
        <div className="picker-head-main" data-tauri-drag-region>
          {onClose ? <BackButton label="Back" onClick={onClose} /> : null}
          <span className="picker-title">{copy.title}</span>
          {!loading && !error && <Badge>{sessions.length}</Badge>}
          <span className="picker-head-actions" data-tauri-drag-region>
            <MetalButton
              windowFocused={windowFocused}
              className="btn btn-primary btn-sm"
              disabled={busy || loading || !projectsRoot}
              onClick={() => choose()}
            >
              {copy.newLabel}
            </MetalButton>
          </span>
        </div>
        {showWindowControls && (
          <span className="picker-head-window" data-tauri-drag-region>
            <RadioButton />
            <WindowLayoutButton />
          </span>
        )}
      </div>

      <div className="picker-list">
        {selectionError && !failedRowShown && selectionErrorBlock}
        {loading && <ListSkeleton rows={5} />}
        {!loading && error && (
          <PickerError
            summary={error.summary}
            detail={error.detail}
            retryDisabled={busy}
            onRetry={() => void load()}
          />
        )}
        {!loading && !error && sessions.length === 0 && (
          <div className="picker-empty">
            <span style={{ color: theme.textMuted }}>{copy.empty}</span>
            <MetalButton
              windowFocused={windowFocused}
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => choose()}
            >
              {copy.newLabel}
            </MetalButton>
          </div>
        )}
        {!loading && !error && sessions.length > 0 && (
          <div className="picker-reveal">
            {sessions.map((session) => (
              <Fragment key={session.id}>
                <button
                  className="picker-item"
                  disabled={busy}
                  aria-describedby={
                    failedRowShown && session.id === failedRowId ? selectionErrorId : undefined
                  }
                  onClick={() => choose(session)}
                >
                  <span className="picker-row">
                    <span className="picker-name picker-preview" style={{ color: theme.text }}>
                      {session.preview || "(no preview)"}
                    </span>
                    <Badge>{session.lastActiveDisplay}</Badge>
                  </span>
                  <span className="picker-meta" style={{ color: theme.textMuted }}>
                    {session.model && <Badge className="picker-model-tag">{session.model}</Badge>}
                    {`${session.messageCount} msgs`}
                  </span>
                  {session.lastReply && <span className="picker-snippet">{session.lastReply}</span>}
                </button>
                {failedRowShown && session.id === failedRowId && selectionErrorBlock}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
