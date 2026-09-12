import { useEffect, useState } from "react";
import { Settings, Download } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { AsciiLogo } from "./AsciiLogo";
import { HomeBackdrop } from "./HomeBackdrop";
import { MemeLayer } from "./MemeLayer";
import { SettingsModal } from "./SettingsModal";
import { TelegramSettingsModal } from "./TelegramSettingsModal";
import { McpModal } from "./McpModal";
import { SteroidsModal } from "./SteroidsModal";
import {
  waitForReady,
  getSettings,
  authStatus,
  getServeStatus,
  getSteroidsStatus,
  onSteroidsChange,
  type SteroidsStatus,
  startServe,
  stopServe,
  openWhatsNewWindow,
  getProgress,
  setRemoteActive,
  type PaneAgentClient,
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
  onLogin: () => void;
  /**
   * Bumped when something OUTSIDE this screen changed serve/auth state (the
   * macOS tray toggling Remote, or its Settings modal saving a projects
   * folder). A counter, not a boolean, so repeats always re-fire.
   */
  refreshSignal?: number;
  waitForAgentReady?: () => Promise<unknown>;
  loadProgress?: () => Promise<ProgressSnapshot | null>;
  mcpClient?: PaneAgentClient;
}

/**
 * App entry screen: the shimmering GG Coder banner over the primary actions.
 * Code and Chat require a configured workspace folder and connected AI provider.
 */
export function HomeScreen({
  onProjects,
  onChat,
  onLogin,
  refreshSignal = 0,
  waitForAgentReady = waitForReady,
  loadProgress = getProgress,
  mcpClient,
}: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerCount, setProviderCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showSteroids, setShowSteroids] = useState(false);
  const [steroids, setSteroids] = useState<SteroidsStatus | null>(null);
  const [serving, setServing] = useState(false);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [serveBusy, setServeBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [showLocalUpdateConfirm, setShowLocalUpdateConfirm] = useState(false);
  const [summarizeDecisions, setSummarizeDecisions] = useState(false);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [showScorecard, setShowScorecard] = useState(false);
  const [unreadWhatsNew, setUnreadWhatsNew] = useState<WhatsNewFeedId[]>([]);
  const appUpdate = useAppUpdate();

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
    void waitForAgentReady()
      .then(() => loadProgress())
      .then(setProgress)
      .catch(() => {});
    void waitForAgentReady()
      .then(() => getSteroidsStatus())
      .then(setSteroids)
      .catch(() => {});
    return onSteroidsChange(setSteroids);
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
    // Serve status lives in the sidecar (the Telegram bot runs there). Best-effort
    // — gate it on readiness but never let it block the native reads above.
    void waitForReady()
      .then(() => getServeStatus())
      .then((serve) => {
        setServing(serve.running);
        setTelegramConfigured(serve.configured);
        void setRemoteActive(serve.running);
      })
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

  async function handleServe(): Promise<void> {
    if (serveBusy) return;
    if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
      return;
    }
    if (!telegramConfigured) {
      toast("Set up Telegram first.", "warning");
      setShowTelegram(true);
      return;
    }
    setServeBusy(true);
    try {
      if (serving) {
        await stopServe();
        setServing(false);
        // Keep the macOS tray's Remote label in step with this button.
        void setRemoteActive(false);
        toast("Stopped serving.", "success");
      } else {
        await startServe();
        setServing(true);
        void setRemoteActive(true);
        toast("Serving on Telegram — message your bot.", "success");
      }
    } catch (e) {
      toast(`Serve failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setServeBusy(false);
    }
  }

  function handleWorkspace(open: () => void): void {
    if (ready) {
      open();
      return;
    }
    // Guide the user to the missing prerequisite(s).
    if (!folderSet) {
      toast("Set a workspace folder first. Open Settings.", "warning");
    }
    if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
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

  return (
    <div className="home" data-tauri-drag-region>
      <HomeBackdrop />
      <MemeLayer />
      <div className="home-header-row">
        <div className="home-header-status">
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
                <span
                  className="home-update-fill"
                  style={{ width: `${appUpdate.progress ?? 0}%` }}
                />
              )}
              <Download size={14} strokeWidth={2.25} aria-hidden="true" />
              {localUpdateStatus ? (
                <span>
                  {appUpdate.statusMessage ?? appUpdate.installLabel}
                  {appUpdate.phase === "error" && " — Retry"}
                </span>
              ) : (
                <span className="home-update-swap">
                  <span
                    className={appUpdate.phase === "installing" ? "home-update-hidden" : undefined}
                  >
                    {appUpdate.installLabel}
                  </span>
                  <span
                    className={appUpdate.phase === "installing" ? undefined : "home-update-hidden"}
                  >
                    Installing…
                    <span className="home-update-pct">{`${appUpdate.progress ?? 0}%`}</span>
                  </span>
                </span>
              )}
            </button>
          ) : (
            version && (
              <div className="home-version-row">
                <span className="home-version">{`v${version}`}</span>
                <RankBadge
                  snapshot={progress}
                  onClick={() => setShowScorecard(true)}
                  className="home-rank-badge"
                />
              </div>
            )
          )}
        </div>
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
      <div className="home-byline">Built for shipping real projects fast</div>
      <div className="home-actions">
        <div className="home-projects-row home-primary-row">
          <button
            className={`btn btn-primary btn-lg home-btn${ready ? "" : " is-dimmed"}`}
            aria-disabled={!ready}
            onClick={() => handleWorkspace(onProjects)}
          >
            Code
          </button>
          <button
            className={`btn btn-primary btn-lg home-btn${ready ? "" : " is-dimmed"}`}
            aria-disabled={!ready}
            onClick={() => handleWorkspace(onChat)}
          >
            Chat
          </button>
          <button
            className="btn btn-ghost btn-icon btn-nav-icon home-settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            <Settings size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="home-projects-row">
          <button
            className={`btn btn-lg home-btn home-steroids-btn${steroids && !steroids.connected ? " is-unroided" : ""}`}
            title="Agent Steroids: real, current code for your agent to read"
            onClick={() => setShowSteroids(true)}
          >
            Steroids
          </button>
          <button className="btn btn-ghost btn-lg home-btn" onClick={onLogin}>
            Login to AI Providers
          </button>
        </div>
        <div className="home-projects-row">
          <button
            className="btn btn-ghost btn-lg home-btn"
            title="Manage MCP servers"
            onClick={() => setShowMcp(true)}
          >
            MCP
          </button>
          <button
            className={`btn btn-ghost btn-lg home-btn${serving ? " home-serve-active" : ""}`}
            disabled={serveBusy}
            onClick={() => void handleServe()}
          >
            {serveBusy ? "Working\u2026" : serving ? "\u25CF Remote · Stop" : "Remote"}
          </button>
          <button
            className="btn btn-ghost btn-icon btn-nav-icon home-settings"
            title="Telegram setup"
            onClick={() => setShowTelegram(true)}
          >
            <Settings size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setFolderSet(true);
            toast("Project folder saved.", "success");
          }}
          onAzureConnectionChanged={() => void refresh().catch(() => {})}
        />
      )}
      {showTelegram && (
        <TelegramSettingsModal
          onClose={() => setShowTelegram(false)}
          onSaved={() => setTelegramConfigured(true)}
        />
      )}
      {showMcp && <McpModal client={mcpClient} onClose={() => setShowMcp(false)} />}
      {showSteroids && (
        <SteroidsModal
          status={steroids}
          onStatus={setSteroids}
          onClose={() => setShowSteroids(false)}
        />
      )}
      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
