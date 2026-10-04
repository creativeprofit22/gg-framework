import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton, useModalEmbedState } from "./modal-embed";
import { Badge } from "./Badge";
import {
  getSettings,
  saveSettings,
  getPermissionsStatus,
  openPermissionsSettings,
  type PermissionsStatus,
} from "./agent";
import { toast } from "./toast";
import { SoundButton } from "./SoundButton";
import { formatBuildIdentity } from "./build-info";
import { AzureConnectionSettings } from "./AzureConnectionSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { HomeBackgroundButton } from "./HomeBackgroundButton";
import { SettingsSection } from "./settings-section";

// One sentence per section, shown as the card description on the Settings page
// and as the hint under the label in the dialog, so the two cannot drift.
const EFFECTS_COPY = "Sound and the home screen's moving background. Changes apply right away.";
const FOLDER_COPY =
  "New projects are created inside this folder. Choose Save folder to keep a change.";

/** A settings card on the page; the dialog shows the content as is. */
function Card({
  embedded,
  children,
}: {
  embedded: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return embedded ? <div className="settings-card">{children}</div> : <>{children}</>;
}

interface Props {
  onClose: () => void;
  /** Called with the saved projects root so callers can refresh. */
  onSaved?: (projectsRoot: string) => void;
}

export function SettingsModal({ onClose, onSaved }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";
  // Only the project folder is an explicitly saved field; Effects and
  // Appearance persist themselves the moment they change.
  const [projectsRoot, setProjectsRoot] = useState("");
  const [savedRoot, setSavedRoot] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null);
  const buildIdentity = formatBuildIdentity();
  const folderId = useId();
  const folderHintId = useId();
  const folderErrorId = useId();
  const folderPendingId = useId();
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    // Native (Rust) read — no sidecar wait needed. `null` means the read failed.
    void getSettings()
      .then((s) => {
        if (!active) return;
        if (s) {
          // An unconfigured app shows a suggested default that hasn't been saved
          // yet, so Save folder must stay available to accept it.
          setSavedRoot(s.configured ? s.projectsRoot : "");
          // Don't clobber anything typed before the read returned.
          setProjectsRoot((typed) => typed || s.projectsRoot);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // The permission is granted OUTSIDE the app (System Settings), so re-check
  // whenever the window regains focus — the common flow is: click "Grant",
  // flip it in System Settings, alt-tab back. Not applicable on platforms with
  // nothing to grant (Windows/Linux) — the row hides itself in that case.
  useEffect(() => {
    const refresh = (): void => void getPermissionsStatus().then(setPermissions);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function browse(): Promise<void> {
    const picked = await open({ directory: true, multiple: false, title: "Projects folder" });
    if (typeof picked === "string") editFolder(picked);
  }

  function editFolder(value: string): void {
    setProjectsRoot(value);
    setSaveError(null);
    setSavedNotice(false);
  }

  const trimmedRoot = projectsRoot.trim();
  const folderChanged = trimmedRoot !== "" && trimmedRoot !== savedRoot;

  async function save(fromRetry = false): Promise<void> {
    if (!folderChanged || busy) return;
    setBusy(true);
    // The error (and its Retry) stays until the outcome is known, so a retry
    // does not pull the focused button out from under the user.
    setSavedNotice(false);
    try {
      // Saved natively in Rust (writes ~/.gg/gg-app.json) — no sidecar round-trip,
      // so this works even while the sidecar is still booting or has crashed.
      await saveSettings(trimmedRoot);
      // Page and dialog both stay open after saving: re-baseline Save folder
      // and confirm inline.
      setSavedRoot(trimmedRoot);
      setSaveError(null);
      setSavedNotice(true);
      onSaved?.(trimmedRoot);
      // Retry is about to disappear; keep focus in the folder section.
      if (fromRetry) folderInputRef.current?.focus();
    } catch (e) {
      // Keep the typed folder so the user can retry or close.
      const reason = e instanceof Error ? e.message : String(e);
      setSaveError(`Couldn't save the project folder: ${reason}`);
      toast(`Couldn't save: ${reason}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const pending = folderChanged && !busy && !saveError;
  const describedBy = [folderHintId, pending && folderPendingId, saveError && folderErrorId]
    .filter(Boolean)
    .join(" ");

  // On the Settings screen this is the General tab; the screen already says
  // "Settings".
  return (
    <Modal title={embedded ? "General" : "Settings"} onClose={onClose} className="settings-modal">
      {/* Columns only on the Settings screen; in the dialog they are
          transparent (see .settings-cols in App.css). */}
      <div className="settings-cols">
        <div className="settings-col">
          {permissions?.applicable && (
            <SettingsSection title="Permissions" description="Full Disk Access for Supah Coder.">
              <div className="modal-row">
                <button
                  className="modal-btn"
                  onClick={() => void openPermissionsSettings()}
                  disabled={permissions.granted}
                >
                  {permissions.granted ? "Permissions granted" : "Grant Permissions…"}
                </button>
                <Badge color={permissions.granted ? theme.success : theme.textMuted}>
                  {permissions.granted ? "Granted" : "Not granted"}
                </Badge>
              </div>
            </SettingsSection>
          )}
          <SettingsSection
            title="Effects"
            description={EFFECTS_COPY}
            dialogHint={
              <div className="modal-hint" style={{ color: theme.textMuted }}>
                {EFFECTS_COPY}
              </div>
            }
          >
            <div className="modal-row">
              <SoundButton />
              <HomeBackgroundButton />
            </div>
          </SettingsSection>
          <Card embedded={embedded}>
            <AppearanceSettings />
          </Card>
        </div>
        <div className="settings-col">
          <SettingsSection
            title="Project folder"
            description={<span id={folderHintId}>{FOLDER_COPY}</span>}
            // The dialog keeps a real <label> and hint; on the page the card
            // title is shown and the input is named through aria-label.
            dialogTitle={null}
            dialogHint={
              <>
                <label
                  className="modal-label"
                  htmlFor={folderId}
                  style={{ color: theme.textMuted }}
                >
                  Project folder
                </label>
                <div id={folderHintId} className="modal-hint" style={{ color: theme.textMuted }}>
                  {FOLDER_COPY}
                </div>
              </>
            }
          >
            <div className="modal-row">
              <input
                ref={folderInputRef}
                id={folderId}
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={projectsRoot}
                placeholder="/Users/you/gg-projects"
                aria-label={embedded ? "Project folder" : undefined}
                aria-describedby={describedBy}
                aria-invalid={saveError ? true : undefined}
                onChange={(e) => editFolder(e.target.value)}
              />
              <button type="button" className="modal-btn" onClick={() => void browse()}>
                {"Browse\u2026"}
              </button>
              {/* Beside the field it saves, on the page and in the dialog. */}
              <button
                type="button"
                className="modal-btn primary settings-folder-save"
                disabled={busy || !folderChanged}
                onClick={() => void save()}
              >
                {busy ? "Saving\u2026" : "Save folder"}
              </button>
            </div>
            {pending && (
              <div id={folderPendingId} className="modal-hint" style={{ color: theme.textMuted }}>
                Not saved yet.
              </div>
            )}
            {/* Always mounted so the confirmation is announced when it appears. */}
            <div
              role="status"
              aria-live="polite"
              className={
                savedNotice ? "settings-folder-status modal-hint" : "settings-folder-status"
              }
              style={{ color: theme.textSecondary }}
            >
              {savedNotice ? "Folder saved." : ""}
            </div>
            {loadError && (
              <div className="modal-hint" style={{ color: theme.textMuted }}>
                {"Couldn\u2019t read the saved folder. Enter one and choose Save folder."}
              </div>
            )}
            {saveError && (
              <div className="settings-folder-error">
                <div
                  id={folderErrorId}
                  className="modal-hint"
                  role="alert"
                  style={{ color: theme.error }}
                >
                  {saveError}
                </div>
                <button
                  type="button"
                  className="modal-btn"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  {busy ? "Retrying\u2026" : "Retry"}
                </button>
              </div>
            )}
          </SettingsSection>
          <Card embedded={embedded}>
            <AzureConnectionSettings />
          </Card>
          {buildIdentity && (
            <div className="modal-build-identity" style={{ color: theme.textDim }}>
              {buildIdentity}
            </div>
          )}
          {/* The page has Back instead; Close discards an unsaved folder edit,
              which the "Not saved yet." hint warns about. */}
          {!embedded && (
            <div className="modal-actions">
              <ModalDismissButton onClick={onClose}>Close</ModalDismissButton>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
