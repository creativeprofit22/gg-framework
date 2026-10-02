import { useEffect, useState } from "react";
import {
  GearSixIcon,
  KeyIcon,
  PuzzlePieceIcon,
  PaperPlaneTiltIcon,
  SyringeIcon,
} from "@phosphor-icons/react";
import { BackButton } from "./BackButton";
import { Badge } from "./Badge";
import { EmbeddedModal } from "./modal-embed";
import { SettingsModal } from "./SettingsModal";
import { LoginScreen } from "./LoginScreen";
import { TelegramSettingsModal } from "./TelegramSettingsModal";
import { McpModal, type McpPaneClient } from "./McpModal";
import { SteroidsModal } from "./SteroidsModal";
import { SettingsTabBar, type SettingsTab } from "./SettingsTabBar";
import {
  SettingsHeaderAction,
  SettingsHeaderProvider,
  SettingsHeaderStatus,
} from "./settings-header";
import {
  waitForReady,
  authStatus,
  getServeStatus,
  startServe,
  stopServe,
  setRemoteActive,
  getSteroidsStatus,
  onSteroidsChange,
  type SteroidsStatus,
} from "./agent";
import { theme } from "./theme";
import { toast } from "./toast";

export type SettingsTabId = "general" | "providers" | "remote" | "mcp" | "steroids";

interface Props {
  onClose: () => void;
  /** The tab to open on, e.g. AI Providers when Code needs a provider. */
  initialTab?: SettingsTabId;
  /** Pane-bound client for the MCP page; there is no primary-pane fallback. */
  mcpClient: McpPaneClient;
}

const PANEL_ID = "settings-panel";

/**
 * Full-screen Settings, reached from the home screen's Settings button. One
 * page per section, switched with yaatuber's floating tab capsule at the
 * bottom. Each page is the same panel the app still opens as a dialog from the
 * tray and the chat view, drawn here in page form (see modal-embed.tsx).
 */
export function SettingsScreen({
  onClose,
  initialTab = "general",
  mcpClient,
}: Props): React.ReactElement {
  const [tab, setTab] = useState<SettingsTabId>(initialTab);
  const [steroids, setSteroids] = useState<SteroidsStatus | null>(null);
  // The header elements pages portal their status and buttons into
  // (settings-header.tsx).
  const [statusSlot, setStatusSlot] = useState<HTMLSpanElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLSpanElement | null>(null);
  // The first page rises in like the other screens' rows; later tab switches
  // crossfade, as in yaatuber's settings.
  const [switched, setSwitched] = useState(false);

  useEffect(() => {
    void waitForReady()
      .then(() => getSteroidsStatus())
      .then(setSteroids)
      .catch(() => {});
    return onSteroidsChange(setSteroids);
  }, []);

  const tabs: SettingsTab<SettingsTabId>[] = [
    { id: "general", label: "General", icon: GearSixIcon },
    { id: "providers", label: "AI Providers", icon: KeyIcon },
    { id: "remote", label: "Remote", icon: PaperPlaneTiltIcon },
    { id: "mcp", label: "MCP", icon: PuzzlePieceIcon },
    {
      id: "steroids",
      label: "Steroids",
      icon: SyringeIcon,
      alert: steroids !== null && !steroids.connected,
    },
  ];

  const current = tabs.find((t) => t.id === tab);

  // Pages stay put after their own Save/Close (the Back button leaves).
  const stay = (): void => {};

  function selectTab(id: SettingsTabId): void {
    setSwitched(true);
    setTab(id);
  }

  return (
    <div className="picker settings-screen">
      <div className="picker-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
        {/* Names the open page; each page's own heading is hidden to match. */}
        <h1 className="picker-title">{current?.label ?? "Settings"}</h1>
        <span className="settings-head-status" ref={setStatusSlot} />
        {/* The open page's buttons, right-aligned on the header's row. */}
        <span className="picker-head-actions settings-head-actions" ref={setActionsSlot} />
      </div>

      <div
        className="settings-scroll"
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        // Remount per tab so each page loads fresh and scroll starts at the top.
        key={tab}
      >
        <SettingsHeaderProvider slots={{ status: statusSlot, actions: actionsSlot }}>
          <div className={`settings-page ${switched ? "is-switching" : "is-entering"}`}>
            {tab === "general" && (
              <EmbeddedModal>
                {/* Save folder confirms inline, as it does in the dialog. */}
                <SettingsModal onClose={stay} />
              </EmbeddedModal>
            )}
            {tab === "providers" && <LoginScreen />}
            {tab === "remote" && <RemotePage />}
            {tab === "mcp" && (
              <EmbeddedModal>
                <McpModal client={mcpClient} onClose={stay} />
              </EmbeddedModal>
            )}
            {tab === "steroids" && (
              <EmbeddedModal>
                <SteroidsModal status={steroids} onStatus={setSteroids} onClose={stay} />
              </EmbeddedModal>
            )}
          </div>
        </SettingsHeaderProvider>
      </div>

      <SettingsTabBar tabs={tabs} selected={tab} onSelect={selectTab} panelId={PANEL_ID} />
    </div>
  );
}

/**
 * Remote: serve this machine to your Telegram bot (formerly the home screen's
 * Remote button). Start/stop sits in the header bar; the page is the bot's
 * setup.
 */
function RemotePage(): React.ReactElement {
  const [serving, setServing] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    await waitForReady();
    const serve = await getServeStatus();
    setServing(serve.running);
    setConfigured(serve.configured);
  }

  useEffect(() => {
    void refresh().catch(() => {});
  }, []);

  async function toggle(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!serving) {
        // The bot hands messages to an agent, so serving needs a provider.
        const providers = await authStatus();
        if (!providers.some((p) => p.connected)) {
          toast("Connect an AI provider first.", "warning");
          return;
        }
      }
      if (serving) {
        await stopServe();
        setServing(false);
        // Keep the macOS tray's Remote label in step.
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
      setBusy(false);
    }
  }

  return (
    // Start/stop lives in the header bar and Live/Off beside the page name, so
    // the page itself is just the bot's setup.
    <>
      <SettingsHeaderStatus>
        <Badge color={serving ? theme.success : undefined}>{serving ? "Live" : "Off"}</Badge>
      </SettingsHeaderStatus>
      <SettingsHeaderAction>
        <button
          className={serving ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
          type="button"
          disabled={busy || (!serving && !configured)}
          title={
            !serving && !configured ? "Save your bot first" : "Message your agent from your phone"
          }
          onClick={() => void toggle()}
        >
          {busy ? "Working\u2026" : serving ? "Stop serving" : "Start serving"}
        </button>
      </SettingsHeaderAction>
      <EmbeddedModal>
        <TelegramSettingsModal onClose={() => {}} onSaved={() => void refresh().catch(() => {})} />
      </EmbeddedModal>
    </>
  );
}
