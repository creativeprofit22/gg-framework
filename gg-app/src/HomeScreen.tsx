import { useEffect, useId, useState } from "react";
import {
  CodeIcon,
  ChatCircleTextIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  GearSixIcon,
} from "@phosphor-icons/react";
import { getVersion } from "@tauri-apps/api/app";
import { AsciiLogo } from "./AsciiLogo";
import { HomeDither } from "./HomeDither";
import { useHomeBackgroundEnabled } from "./home-background";
import type { SettingsTabId } from "./SettingsScreen";
import {
  waitForReady,
  getSettings,
  authStatus,
  openWhatsNewWindow,
  getProgress,
  setRemoteActive,
  getServeStatus,
  type ProgressSnapshot,
} from "./agent";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { useAppUpdate } from "./update";
import { ConfirmModal } from "./ConfirmModal";
import { LocalUpdateSummaryOption } from "./LocalUpdateSummaryOption";
import {
  LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL,
  LOCAL_UPDATE_CONFIRMATION_MESSAGE,
  LOCAL_UPDATE_CONFIRMATION_TITLE,
  shouldConfirmLocalUpdate,
} from "./local-update-confirmation";
import { toast } from "./toast";
import type { WhatsNewFeedId } from "./whats-new-status";
import { error as logError } from "@tauri-apps/plugin-log";

interface Props {
  onProjects: () => void;
  onChat: () => void;
  onMotion: () => void;
  /** Opens full-screen Settings, optionally on a given tab. */
  onSettings: (tab?: SettingsTabId) => void;
  /**
   * Bumped when something OUTSIDE this screen changed serve/auth state (the
   * macOS tray toggling Remote, or its Settings modal saving a projects
   * folder). A counter, not a boolean, so repeats always re-fire.
   */
  refreshSignal?: number;
  waitForAgentReady?: () => Promise<unknown>;
  loadProgress?: () => Promise<ProgressSnapshot | null>;
}

/**
 * App entry screen: the shimmering Supah Coder banner over the primary actions.
 * Code, Chat and Motion require a configured workspace folder and connected AI provider;
 * everything else lives in full-screen Settings (the top-right gear).
 */
export function HomeScreen({
  onProjects,
  onChat,
  onMotion,
  onSettings,
  refreshSignal = 0,
  waitForAgentReady = waitForReady,
  loadProgress = getProgress,
}: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerCount, setProviderCount] = useState(0);
  const [version, setVersion] = useState<string | null>(null);
  const [showLocalUpdateConfirm, setShowLocalUpdateConfirm] = useState(false);
  const [summarizeDecisions, setSummarizeDecisions] = useState(false);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [showScorecard, setShowScorecard] = useState(false);
  const [unreadWhatsNew, setUnreadWhatsNew] = useState<WhatsNewFeedId[]>([]);
  const appUpdate = useAppUpdate();
  const motionNoteId = useId();

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
    void waitForAgentReady()
      .then(() => loadProgress())
      .then(setProgress)
      .catch(() => {});
  }, [loadProgress, waitForAgentReady]);

  async function refresh(): Promise<void> {
    // Settings + auth are read NATIVELY (Rust) — do them first, WITHOUT waiting on
    // the sidecar, so the workspace gate never stays dimmed just because the
    // agent is slow/crashed.
    const [settings, providers] = await Promise.all([getSettings(), authStatus()]);
    // Prefer the explicit `configured` flag; fall back to a non-empty root so an
    // older sidecar (one that predates the flag) degrades to "set" instead of
    // dimming forever.
    setFolderSet(settings?.configured ?? Boolean(settings?.projectsRoot));
    setProviderCount(providers.filter((p) => p.connected).length);
    // Keep the macOS tray's Remote label in step with the sidecar (it may have
    // respawned). Best-effort, and never blocks the native reads above.
    void waitForReady()
      .then(() => getServeStatus())
      .then((serve) => void setRemoteActive(serve.running))
      .catch(() => {});
  }

  useEffect(() => {
    void refresh().catch(() => {});
    // Re-check when the window regains focus so a folder/provider set elsewhere
    // (or after a sidecar respawn) reflects without an app restart.
    const onFocus = (): void => void refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Skips the initial 0 so mounting doesn't double-refresh.
  useEffect(() => {
    if (refreshSignal > 0) void refresh().catch(() => {});
  }, [refreshSignal]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import("./whats-new-status")
      .then(({ getWhatsNewStatus, WHATS_NEW_STORAGE_KEY }) => {
        if (cancelled) return;
        const refreshUnread = (): void => {
          setUnreadWhatsNew(getWhatsNewStatus(localStorage, appUpdate.localPatched).unreadFeedIds);
        };
        const onStorage = (event: StorageEvent): void => {
          if (event.key === null || event.key === WHATS_NEW_STORAGE_KEY) refreshUnread();
        };
        refreshUnread();
        window.addEventListener("focus", refreshUnread);
        window.addEventListener("storage", onStorage);
        cleanup = () => {
          window.removeEventListener("focus", refreshUnread);
          window.removeEventListener("storage", onStorage);
        };
      })
      .catch((error) => {
        if (!cancelled) void logError(`What's-new status failed: ${String(error)}`);
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [appUpdate.localPatched]);

  const ready = folderSet && providerCount > 0;

  function handleWorkspace(open: () => void): void {
    if (ready) {
      open();
      return;
    }
    // Take the user to the missing prerequisite: the folder first (General),
    // then a provider.
    if (!folderSet) {
      toast("Set a workspace folder first.", "warning");
      onSettings("general");
    } else if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
      onSettings("providers");
    }
  }

  const showUpdate =
    appUpdate.phase === "available" ||
    appUpdate.phase === "installing" ||
    (appUpdate.localPatched && (appUpdate.phase === "completed" || appUpdate.phase === "error"));
  const localUpdateStatus =
    appUpdate.localPatched &&
    (appUpdate.phase === "installing" ||
      appUpdate.phase === "completed" ||
      appUpdate.phase === "error");
  const unreadLabels = unreadWhatsNew.map((id) => (id === "local" ? "Local Fork" : "Upstream"));
  const whatsNewLabel =
    unreadLabels.length > 0
      ? `What's new, unread from ${unreadLabels.join(" and ")}`
      : "What's new";
  const backgroundOn = useHomeBackgroundEnabled();

  return (
    <div className="home" data-tauri-drag-region>
      {backgroundOn && <HomeDither />}
      {/* Above the banner: your rank and What's new. */}
      <div className="home-version-row">
        <RankBadge
          snapshot={progress}
          onClick={() => setShowScorecard(true)}
          className="home-rank-badge"
        />
        <button
          className="home-whatsnew"
          type="button"
          aria-label={whatsNewLabel}
          title={whatsNewLabel}
          onClick={() => void openWhatsNewWindow().catch(() => {})}
        >
          <span>What&apos;s new</span>
          {unreadWhatsNew.map((id) => (
            <span
              key={id}
              className={`home-whatsnew-dot feed-${id}`}
              title={`${id === "local" ? "Local Fork" : "Upstream"} unread`}
              aria-hidden="true"
            />
          ))}
        </button>
      </div>
      {showLocalUpdateConfirm && (
        <ConfirmModal
          title={LOCAL_UPDATE_CONFIRMATION_TITLE}
          message={LOCAL_UPDATE_CONFIRMATION_MESSAGE}
          confirmLabel={LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL}
          content={
            <LocalUpdateSummaryOption
              checked={summarizeDecisions}
              onChange={setSummarizeDecisions}
            />
          }
          onConfirm={() => {
            setShowLocalUpdateConfirm(false);
            void appUpdate.install({ summarizeDecisions });
            setSummarizeDecisions(false);
          }}
          onClose={() => {
            setShowLocalUpdateConfirm(false);
            setSummarizeDecisions(false);
          }}
        />
      )}
      <AsciiLogo />
      <div className="home-tagline">Cause the other coding agents piss me off</div>
      <div className="home-actions">
        <button
          type="button"
          className={`btn btn-primary home-action${ready ? "" : " is-dimmed"}`}
          aria-disabled={ready ? undefined : true}
          onClick={() => handleWorkspace(onProjects)}
        >
          <CodeIcon size={18} weight="bold" aria-hidden="true" />
          Code
        </button>
        <button
          type="button"
          className={`btn btn-primary home-action${ready ? "" : " is-dimmed"}`}
          aria-disabled={ready ? undefined : true}
          onClick={() => handleWorkspace(onChat)}
        >
          <ChatCircleTextIcon size={18} weight="bold" aria-hidden="true" />
          Chat
        </button>
        {/* Motion is still being built, so its button says so underneath. */}
        <div className="home-action-slot">
          <button
            type="button"
            className={`btn btn-primary home-action${ready ? "" : " is-dimmed"}`}
            aria-disabled={ready ? undefined : true}
            aria-describedby={motionNoteId}
            onClick={() => handleWorkspace(onMotion)}
          >
            <FilmSlateIcon size={18} weight="bold" aria-hidden="true" />
            Motion
          </button>
          <span id={motionNoteId} className="home-action-note">
            Still in process
          </span>
        </div>
      </div>
      <button
        type="button"
        className="icon-circle home-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => onSettings()}
      >
        <GearSixIcon size={20} weight="bold" aria-hidden="true" />
      </button>
      {/* Bottom centre: the Local Fork byline (upstream's author links are not shown). */}
      <div className="home-byline home-links">Built for shipping real projects fast</div>
      {/* Bottom left: the version, or the update button when one is ready. */}
      <div className="home-version-corner">
        {showUpdate ? (
          <button
            className={`home-update${appUpdate.phase === "installing" ? " home-update-progress" : ""}`}
            disabled={appUpdate.phase === "installing" || appUpdate.phase === "completed"}
            title={appUpdate.installTitle}
            onClick={() => {
              if (shouldConfirmLocalUpdate(appUpdate.localPatched, appUpdate.phase)) {
                setSummarizeDecisions(false);
                setShowLocalUpdateConfirm(true);
              } else {
                void appUpdate.install();
              }
            }}
          >
            {appUpdate.phase === "installing" && !appUpdate.localPatched && (
              <span className="home-update-fill" style={{ width: `${appUpdate.progress ?? 0}%` }} />
            )}
            <DownloadSimpleIcon size={14} weight="bold" aria-hidden="true" />
            {localUpdateStatus ? (
              <span>
                {appUpdate.statusMessage ?? appUpdate.installLabel}
                {appUpdate.phase === "error" && " — Retry"}
              </span>
            ) : (
              /* Both labels occupy the same grid cell; the inactive one is
                visibility:hidden, so the pill is ALWAYS sized to the wider of
                the two and never resizes when the install starts or the
                percentage climbs. */
              <span className="home-update-swap">
                <span
                  className={appUpdate.phase === "installing" ? "home-update-hidden" : undefined}
                >
                  {appUpdate.installLabel}
                </span>
                <span
                  className={appUpdate.phase === "installing" ? undefined : "home-update-hidden"}
                >
                  {"Installing\u2026"}
                  <span className="home-update-pct">{`${appUpdate.progress ?? 0}%`}</span>
                </span>
              </span>
            )}
          </button>
        ) : (
          version && <span className="home-version">{`v${version}`}</span>
        )}
      </div>

      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
