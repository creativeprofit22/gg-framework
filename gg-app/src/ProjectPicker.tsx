import { Fragment, useCallback, useEffect, useId, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import {
  waitForReady,
  listProjects,
  setProjectHidden,
  listSessions,
  importTranscript,
  getSettings,
  saveSettings,
  focusWindowByOffset,
  arrangeAllWindows,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { Badge } from "./Badge";
import { sourceStyle } from "./source-style";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { ListSkeleton } from "./Skeleton";
import { BackButton } from "./BackButton";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { RadioButton } from "./RadioButton";
import { NewProjectModal } from "./NewProjectModal";
import { MetalButton } from "./MetalButton";
import { useWindowFocused } from "./useWindowFocused";
import { describeActionFailure, describeOpenFailure, type FailureCopy } from "./open-failure";
import { PickerError } from "./PickerError";
import { PickerMoreMenu } from "./PickerMoreMenu";

/**
 * Does this row point at another tool's transcript rather than a GG Coder
 * session? Those need an import before they can be opened.
 */
function isForeignSession(session: RecentSession): boolean {
  return session.source === "claude-code" || session.source === "codex";
}

/** Stable comparison across Windows casing, slash, and extended-length forms. */
function projectPathKey(projectPath: string): string {
  let normalized = projectPath.trim();
  const lowerPath = normalized.toLowerCase();
  if (lowerPath.startsWith("\\\\?\\unc\\")) normalized = `\\\\${normalized.slice(8)}`;
  else if (lowerPath.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  const windowsPath = /^[a-z]:[\\/]/i.test(normalized) || normalized.startsWith("\\\\");
  normalized = normalized.replace(/\\/g, "/").replace(/\/+$/, "");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

/** A failed open, split into what the user reads and what support needs. */
interface ResumeFailure extends FailureCopy {
  /** What to reopen. Data, not a closure, so Retry runs this render's `busy` guard. */
  retry:
    | { cwd: string; sessionPath?: string; row?: RecentSession }
    | { cwd: string; session: RecentSession };
  /** The session row the failure belongs to; the error renders beneath it. */
  rowId?: string;
}

interface Props {
  /** Called after the agent has been re-pointed at `cwd` (+ optional session). */
  onChosen: (cwd: string) => void;
  /**
   * When set, open straight to this project's session list (used by the "back
   * to sessions" affordance from inside a project). Falls back to the full
   * project list if the path isn't among the discovered projects.
   */
  initialProjectPath?: string | null;
  /** Shown when the picker is reachable from an open project (enables "back"). */
  onClose?: () => void;
  waitForCatalogReady?: () => Promise<unknown>;
  discoverProjects?: () => Promise<DiscoveredProject[]>;
  discoverSessions?: (cwd: string) => Promise<RecentSession[]>;
  bindProject: (cwd: string, sessionPath?: string) => Promise<unknown>;
  saveProjectsRoot?: (projectsRoot: string) => Promise<unknown>;
  refreshSignal?: number;
  showWindowControls?: boolean;
}

/**
 * Full-window project chooser shown when a window has no project yet. Lists
 * every known project (ggcoder/Claude Code/Codex). Selecting one reveals its
 * latest sessions; picking "New session" or an existing session re-points this
 * window's agent at that project cwd.
 */
export function ProjectPicker({
  onChosen,
  initialProjectPath,
  onClose,
  waitForCatalogReady = waitForReady,
  discoverProjects = listProjects,
  discoverSessions = listSessions,
  bindProject,
  saveProjectsRoot = saveSettings,
  refreshSignal = 0,
  showWindowControls = true,
}: Props): React.ReactElement {
  const windowFocused = useWindowFocused();
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<FailureCopy | null>(null);
  const [folderError, setFolderError] = useState<FailureCopy | null>(null);
  const [selected, setSelected] = useState<DiscoveredProject | null>(null);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<FailureCopy | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeError, setResumeError] = useState<ResumeFailure | null>(null);
  const resumeErrorId = useId();
  const [projectsRoot, setProjectsRoot] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    : projects;

  // Multi-window shortcuts work from the picker too, so you can cycle/arrange
  // before choosing a project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
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

  useEffect(() => {
    let cancelled = false;
    // Settings are read natively (Rust) — no sidecar wait needed. Re-read on
    // refreshSignal so a tray Settings folder change updates the New project
    // preview (Rust creates under the freshly read root).
    void getSettings()
      .then((s) => {
        if (!cancelled && s) setProjectsRoot(s.projectsRoot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  const openProject = useCallback(
    (project: DiscoveredProject): void => {
      setSelected(project);
      setSessions([]);
      setResumeError(null);
      setSessionsError(null);
      setSessionsLoading(true);
      void discoverSessions(project.path)
        .then((nextSessions) => {
          setSessions(nextSessions);
          setSessionsLoading(false);
        })
        .catch((reason: unknown) => {
          setSessionsError(describeActionFailure("load sessions", reason));
          setSessionsLoading(false);
        });
    },
    [discoverSessions],
  );

  /** Reload the project catalog after startup, a failed request, or a root change. */
  const reloadProjects = useCallback(async (): Promise<void> => {
    setLoading(true);
    setProjectsError(null);
    try {
      // The window's sidecar serves project discovery; wait for it before asking.
      await waitForCatalogReady();
      const nextProjects = await discoverProjects();
      setProjects(nextProjects);
      // Deep-link straight to the current project's sessions when asked.
      if (initialProjectPath) {
        const initialPathKey = projectPathKey(initialProjectPath);
        const match = nextProjects.find(
          (project) => projectPathKey(project.path) === initialPathKey,
        );
        if (match) openProject(match);
      }
    } catch (reason: unknown) {
      setProjectsError(describeActionFailure("load projects", reason));
    } finally {
      setLoading(false);
    }
  }, [discoverProjects, initialProjectPath, openProject, waitForCatalogReady]);

  useEffect(() => {
    void reloadProjects();
  }, [refreshSignal, reloadProjects]);

  /**
   * Drop a project from the list and persist the decision. Removed optimistically
   * because discovery is a multi-store filesystem scan — re-listing to confirm
   * would leave the row sitting there for a visible beat.
   */
  function hideProject(project: DiscoveredProject): void {
    let index = -1;
    setProjects((prev) => {
      index = prev.findIndex((p) => p.path === project.path);
      return prev.filter((p) => p.path !== project.path);
    });
    void setProjectHidden(project.path, true).catch(() => {
      // Persisting failed, so the row is still real: put it back at its old
      // position rather than leaving the list disagreeing with what the next
      // launch will show. Rows are sorted by recency server-side, so restoring
      // by index preserves that order without duplicating the sort here.
      setProjects((prev) => {
        if (prev.some((p) => p.path === project.path)) return prev;
        const next = [...prev];
        next.splice(index < 0 ? next.length : index, 0, project);
        return next;
      });
    });
  }

  /**
   * Bind this window to `cwd` (+ optional session). `row` is the list row the
   * user clicked, if any — an imported session opens by a new path, so the row
   * is carried separately to keep a failure beside what was clicked.
   */
  function choose(cwd: string, sessionPath?: string, row?: RecentSession): void {
    if (busy) return;
    setBusy(true);
    setResumeError(null);
    // The pane client resolves only after the selected daemon generation is ready.
    // A failed resume therefore stays in the picker and shows its real cause.
    void bindProject(cwd, sessionPath)
      .then(() => onChosen(cwd))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setResumeError({
          ...describeOpenFailure(message, row?.preview),
          retry: {
            cwd,
            ...(sessionPath === undefined ? {} : { sessionPath }),
            ...(row ? { row } : {}),
          },
          ...(row ? { rowId: row.id } : {}),
        });
        setBusy(false);
      });
  }

  /**
   * Open a session row. A native row resumes directly; a Claude Code / Codex row
   * is imported into a real GG Coder session first, then opened by its new path.
   * The import is silent — from the user's side this is just "open that
   * conversation", which is why there is no separate import affordance.
   */
  function chooseSession(cwd: string, session: RecentSession): void {
    if (busy) return;
    if (!isForeignSession(session)) {
      choose(cwd, session.path, session);
      return;
    }
    setBusy(true);
    setResumeError(null);
    void importTranscript(session.path, cwd)
      .then((result) => {
        if (!result.ok) {
          setResumeError({
            ...describeActionFailure("import that conversation", result.error),
            retry: { cwd, session },
            rowId: session.id,
          });
          setBusy(false);
          return;
        }
        // Re-enter the normal resume path with the freshly written session.
        setBusy(false);
        choose(cwd, result.sessionPath, session);
      })
      .catch((reason: unknown) => {
        setResumeError({
          ...describeActionFailure("import that conversation", reason),
          retry: { cwd, session },
          rowId: session.id,
        });
        setBusy(false);
      });
  }

  // Open one exact folder as a project, without changing the discovery root.
  function openExisting(): void {
    if (busy) return;
    void openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open project directly",
    })
      .then((picked) => {
        if (typeof picked === "string") choose(picked);
      })
      .catch(() => {});
  }

  // Save a parent folder as the discovery root, then immediately refresh so its
  // direct child projects become visible without restarting the app.
  function addProjectsFolder(): void {
    if (busy) return;
    setFolderError(null);
    void openFolderDialog({
      directory: true,
      multiple: false,
      title: "Add projects folder",
    })
      .then(async (picked) => {
        if (typeof picked !== "string") return;
        setBusy(true);
        try {
          await saveProjectsRoot(picked);
          setProjectsRoot(picked);
          setQuery("");
          await reloadProjects();
        } catch (reason: unknown) {
          setFolderError(describeActionFailure("add that projects folder", reason));
        } finally {
          setBusy(false);
        }
      })
      .catch((reason: unknown) => {
        setFolderError(describeActionFailure("open the folder picker", reason));
      });
  }

  // A failed open sits directly under the row that was clicked; a new session
  // or a direct folder open has no row, so its error stays at the top.
  const failedRowId = resumeError?.rowId;
  const failedRowShown =
    !sessionsLoading && failedRowId !== undefined && sessions.some((s) => s.id === failedRowId);
  const resumeErrorBlock = resumeError && (
    <PickerError
      id={resumeErrorId}
      summary={resumeError.summary}
      detail={resumeError.detail}
      retryDisabled={busy}
      onRetry={() => {
        const target = resumeError.retry;
        if ("session" in target) chooseSession(target.cwd, target.session);
        else choose(target.cwd, target.sessionPath, target.row);
      }}
    />
  );

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        {/* The page's own controls share the list's column; window controls stay at the edge. */}
        <div className="picker-head-main" data-tauri-drag-region>
          {selected ? (
            <BackButton label="All projects" onClick={() => setSelected(null)} />
          ) : onClose ? (
            <BackButton label="Back" onClick={onClose} />
          ) : null}
          <span className="picker-title">{selected ? selected.name : "Choose a project"}</span>
          {!selected && !loading && <Badge>{projects.length}</Badge>}
          {!selected && !loading && projects.length > 0 && (
            <input
              className="picker-search"
              type="text"
              placeholder={"Search projects\u2026"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search projects"
            />
          )}
          <span className="picker-head-actions" data-tauri-drag-region>
            {selected ? (
              <MetalButton
                windowFocused={windowFocused}
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => choose(selected.path)}
              >
                {"+ New session"}
              </MetalButton>
            ) : (
              <>
                {/* Wide panes show the secondary actions inline; narrow panes
                    (container query in App.css) fold them into More. */}
                <span className="picker-actions-wide" data-tauri-drag-region>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={addProjectsFolder}
                  >
                    {"Add projects folder"}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={openExisting}
                  >
                    {"Open project directly"}
                  </button>
                </span>
                <span className="picker-actions-narrow">
                  <PickerMoreMenu
                    disabled={busy}
                    items={[
                      { label: "Add projects folder", onSelect: addProjectsFolder },
                      { label: "Open project directly", onSelect: openExisting },
                    ]}
                  />
                </span>
                <MetalButton
                  windowFocused={windowFocused}
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowNew(true)}
                >
                  {"+ New project"}
                </MetalButton>
              </>
            )}
          </span>
        </div>
        {showWindowControls && (
          <span className="picker-head-window" data-tauri-drag-region>
            <RadioButton />
            <WindowLayoutButton />
          </span>
        )}
      </div>

      {!selected ? (
        <div className="picker-list">
          {/* "Open project directly" fails here, with no row to sit under. */}
          {resumeError && resumeErrorBlock}
          {loading && <ListSkeleton rows={6} />}
          {!loading && projectsError && (
            <PickerError
              summary={projectsError.summary}
              detail={projectsError.detail}
              onRetry={() => void reloadProjects()}
            />
          )}
          {!loading && folderError && (
            <PickerError
              summary={folderError.summary}
              detail={folderError.detail}
              retryDisabled={busy}
              onRetry={addProjectsFolder}
            />
          )}
          {!loading && !projectsError && projects.length === 0 && (
            <div className="picker-empty">
              <span style={{ color: theme.textMuted }}>No projects yet.</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={addProjectsFolder}
                >
                  {"Add projects folder"}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={openExisting}
                >
                  {"Open project directly"}
                </button>
                <MetalButton
                  windowFocused={windowFocused}
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowNew(true)}
                >
                  {"+ New project"}
                </MetalButton>
              </span>
            </div>
          )}
          {!loading && projects.length > 0 && filteredProjects.length === 0 && (
            <div className="picker-empty" style={{ color: theme.textMuted }}>
              {`No projects match \u201c${query.trim()}\u201d`}
            </div>
          )}
          {!loading && filteredProjects.length > 0 && (
            <div className="picker-reveal">
              {filteredProjects.map((p) => (
                <div key={p.path} className="picker-item-wrap">
                  <button className="picker-item" onClick={() => openProject(p)} title={p.path}>
                    <span className="picker-row">
                      <span className="picker-name" style={{ color: theme.text }}>
                        {p.name}
                      </span>
                      <Badge>{p.lastActiveDisplay}</Badge>
                    </span>
                    {/* Where the project comes from, as tinted glass pills. */}
                    <span className="picker-sources">
                      {p.sources.map((s) => {
                        const { label, color } = sourceStyle(s);
                        return (
                          <Badge key={s} color={color}>
                            {label}
                          </Badge>
                        );
                      })}
                    </span>
                  </button>
                  <button
                    className="picker-hide"
                    aria-label={`Hide ${p.name}`}
                    title="Hide from this list"
                    onClick={() => hideProject(p)}
                  >
                    {/* The same drawn X as the modal close buttons: a text ×
                        sits low and off-centre in a round button. */}
                    <XIcon size={12} weight="bold" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="picker-list">
          {resumeError && !failedRowShown && resumeErrorBlock}
          {sessionsLoading && <ListSkeleton rows={4} />}
          {!sessionsLoading && sessionsError && (
            <PickerError
              summary={sessionsError.summary}
              detail={sessionsError.detail}
              onRetry={() => openProject(selected)}
            />
          )}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <div className="picker-empty">
              <span style={{ color: theme.textMuted }}>No previous sessions yet.</span>
              <MetalButton
                windowFocused={windowFocused}
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => choose(selected.path)}
              >
                {"+ New session"}
              </MetalButton>
            </div>
          )}
          {!sessionsLoading && sessions.length > 0 && (
            <div className="picker-reveal">
              {sessions.map((s) => (
                <Fragment key={s.id}>
                  <button
                    className="picker-item"
                    disabled={busy}
                    aria-describedby={
                      failedRowShown && s.id === failedRowId ? resumeErrorId : undefined
                    }
                    onClick={() => chooseSession(selected.path, s)}
                    title={
                      isForeignSession(s)
                        ? `From ${sourceStyle(s.source ?? "").label} — opens as a ${PRODUCT_DISPLAY_NAME} session`
                        : undefined
                    }
                  >
                    <span className="picker-row">
                      <span className="picker-name picker-preview" style={{ color: theme.text }}>
                        {s.preview || "(no preview)"}
                      </span>
                      <Badge>{s.lastActiveDisplay}</Badge>
                    </span>
                    <span className="picker-meta" style={{ color: theme.textMuted }}>
                      {isForeignSession(s) && (
                        <Badge
                          className="picker-source-tag"
                          color={sourceStyle(s.source ?? "").color}
                        >
                          {sourceStyle(s.source ?? "").label}
                        </Badge>
                      )}
                      {s.model && <Badge className="picker-model-tag">{s.model}</Badge>}
                      <Badge>{`${s.messageCount} msgs`}</Badge>
                    </span>
                    {s.lastReply && <span className="picker-snippet">{s.lastReply}</span>}
                  </button>
                  {failedRowShown && s.id === failedRowId && resumeErrorBlock}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {showNew && (
        <NewProjectModal
          projectsRoot={projectsRoot}
          onClose={() => setShowNew(false)}
          onCreated={async (cwd) => {
            await bindProject(cwd);
            setShowNew(false);
            onChosen(cwd);
          }}
        />
      )}
    </div>
  );
}
