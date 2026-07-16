import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import {
  waitForReady,
  listProjects,
  listSessions,
  selectProject,
  getSettings,
  focusWindowByOffset,
  arrangeAllWindows,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { Badge, sourceStyle } from "./Badge";
import { ListSkeleton } from "./Skeleton";
import { BackButton } from "./BackButton";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { RadioButton } from "./RadioButton";
import { NewProjectModal } from "./NewProjectModal";
import { toast } from "./toast";

export interface ProjectPickerProps {
  /** Called after the selected project/session has been bound to the owning pane. */
  onChosen: (cwd: string) => void;
  initialProjectPath?: string | null;
  onClose?: () => void;
  waitForCatalogReady?: () => Promise<unknown>;
  discoverProjects?: () => Promise<DiscoveredProject[]>;
  discoverSessions?: (cwd: string) => Promise<RecentSession[]>;
  bindProject?: (cwd: string, sessionPath?: string) => Promise<unknown>;
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
  bindProject = selectProject,
  showWindowControls = true,
}: ProjectPickerProps): React.ReactElement {
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DiscoveredProject | null>(null);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState("");
  const sessionRequestRef = useRef(0);

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
      const requestId = ++sessionRequestRef.current;
      setSelected(project);
      setSessions([]);
      setSessionsLoading(true);
      void discoverSessions(project.path)
        .then((nextSessions) => {
          if (requestId === sessionRequestRef.current) setSessions(nextSessions);
        })
        .catch(() => {
          if (requestId === sessionRequestRef.current) setSessions([]);
        })
        .finally(() => {
          if (requestId === sessionRequestRef.current) setSessionsLoading(false);
        });
    },
    [discoverSessions],
  );

  useEffect(() => {
    return () => {
      sessionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The pane-scoped client must be ready before its project catalog is queried.
    void waitForCatalogReady()
      .then(() => discoverProjects())
      .then((p) => {
        if (cancelled) return;
        setProjects(p);
        setLoading(false);
        // Deep-link straight to the current project's sessions when asked.
        if (initialProjectPath) {
          const match = p.find((proj) => proj.path === initialProjectPath);
          if (match) openProject(match);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoading(false);
        toast(
          `Agent failed to start: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [discoverProjects, initialProjectPath, openProject, waitForCatalogReady]);

  function choose(cwd: string, sessionPath?: string): void {
    if (busy) return;
    setBusy(true);
    void bindProject(cwd, sessionPath)
      .then(() => onChosen(cwd))
      .catch(() => setBusy(false));
  }

  // Open an existing folder from disk as a project. The native folder picker is
  // directories-only (that's where projects live); a chosen path re-points this
  // window's agent exactly like selecting a discovered project.
  function openExisting(): void {
    if (busy) return;
    void openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open existing project",
    })
      .then((picked) => {
        if (typeof picked === "string") choose(picked);
      })
      .catch(() => {});
  }

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        {selected ? (
          <BackButton
            label="All projects"
            onClick={() => {
              sessionRequestRef.current += 1;
              setSelected(null);
            }}
          />
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
                onClick={openExisting}
              >
                {"Open existing"}
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
          {!loading && projects.length === 0 && (
            <div className="picker-empty">
              <span style={{ color: theme.textMuted }}>No projects yet.</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={openExisting}
                >
                  {"Open existing"}
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
                <button
                  key={p.path}
                  className="picker-item"
                  onClick={() => openProject(p)}
                  title={p.path}
                >
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
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="picker-list">
          {sessionsLoading && <ListSkeleton rows={4} />}
          {!sessionsLoading && sessions.length === 0 && (
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
                  onClick={() => choose(selected.path, s.path)}
                >
                  <span className="picker-row">
                    <span className="picker-name picker-preview" style={{ color: theme.text }}>
                      {s.preview || "(no preview)"}
                    </span>
                    <Badge>{s.lastActiveDisplay}</Badge>
                  </span>
                  <span className="picker-meta" style={{ color: theme.textMuted }}>
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
          onCreated={(cwd) => {
            setShowNew(false);
            onChosen(cwd);
          }}
        />
      )}
    </div>
  );
}
