import { useCallback, useEffect, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
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
import { Badge, sourceStyle } from "./Badge";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { ListSkeleton } from "./Skeleton";
import { BackButton } from "./BackButton";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { RadioButton } from "./RadioButton";
import { NewProjectModal } from "./NewProjectModal";

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
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DiscoveredProject | null>(null);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
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
    // Settings are read natively (Rust) — no sidecar wait needed.
    void getSettings()
      .then((s) => {
        if (!cancelled && s) setProjectsRoot(s.projectsRoot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
        .catch(() => {
          setSessionsError("Couldn’t load sessions. Please try again.");
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
    } catch {
      setProjectsError("Couldn’t load projects. Please try again.");
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

  function choose(cwd: string, sessionPath?: string): void {
    if (busy) return;
    setBusy(true);
    setResumeError(null);
    // The pane client resolves only after the selected daemon generation is ready.
    // A failed resume therefore stays in the picker and shows its real cause.
    void bindProject(cwd, sessionPath)
      .then(() => onChosen(cwd))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setResumeError(
          message
            .replace(/Run ["'`]?ggcoder login["'`]?/gi, "Use AI Providers to sign in")
            .replace(/ggcoder login/gi, "AI Providers"),
        );
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
      choose(cwd, session.path);
      return;
    }
    setBusy(true);
    setResumeError(null);
    void importTranscript(session.path, cwd)
      .then((result) => {
        if (!result.ok) {
          setResumeError(`Could not import that conversation: ${result.error}`);
          setBusy(false);
          return;
        }
        // Re-enter the normal resume path with the freshly written session.
        setBusy(false);
        choose(cwd, result.sessionPath);
      })
      .catch((reason: unknown) => {
        setResumeError(
          `Could not import that conversation: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
        );
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
          const detail = reason instanceof Error ? reason.message : String(reason);
          setFolderError(`Couldn’t add that projects folder: ${detail}`);
        } finally {
          setBusy(false);
        }
      })
      .catch((reason: unknown) => {
        const detail = reason instanceof Error ? reason.message : String(reason);
        setFolderError(`Couldn’t open the folder picker: ${detail}`);
      });
  }

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
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
        <span className="picker-head-actions">
          {selected ? (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => choose(selected.path)}
            >
              {"+ New session"}
            </button>
          ) : (
            <>
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
              <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
                {"+ New project"}
              </button>
            </>
          )}
          {showWindowControls && (
            <>
              <RadioButton />
              <WindowLayoutButton />
            </>
          )}
        </span>
      </div>

      {!selected ? (
        <div className="picker-list">
          {loading && <ListSkeleton rows={6} />}
          {!loading && projectsError && (
            <div className="picker-error" role="alert">
              <div>{projectsError}</div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => void reloadProjects()}
              >
                Retry
              </button>
            </div>
          )}
          {!loading && folderError && (
            <div className="picker-error" role="alert">
              {folderError}
            </div>
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
                <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
                  {"+ New project"}
                </button>
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
                    <span className="picker-sources">
                      {p.sources.map((s, i) => {
                        const { label, color } = sourceStyle(s);
                        return (
                          <span key={s} style={{ color }}>
                            {i > 0 ? (
                              <span style={{ color: theme.textDim }}>{" \u00b7 "}</span>
                            ) : null}
                            {label}
                          </span>
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
                    {"\u00d7"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="picker-list">
          {resumeError && (
            <div className="picker-error" role="alert">
              {resumeError}
            </div>
          )}
          {sessionsLoading && <ListSkeleton rows={4} />}
          {!sessionsLoading && sessionsError && (
            <div className="picker-error" role="alert">
              <div>{sessionsError}</div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => openProject(selected)}
              >
                Retry
              </button>
            </div>
          )}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <div className="picker-empty">
              <span style={{ color: theme.textMuted }}>No previous sessions yet.</span>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => choose(selected.path)}
              >
                {"+ New session"}
              </button>
            </div>
          )}
          {!sessionsLoading && sessions.length > 0 && (
            <div className="picker-reveal">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  className="picker-item"
                  disabled={busy}
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
                      <span
                        className="picker-source-tag"
                        style={{ color: sourceStyle(s.source ?? "").color }}
                      >
                        {sourceStyle(s.source ?? "").label}
                      </span>
                    )}
                    {`${s.messageCount} msgs`}
                  </span>
                </button>
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
