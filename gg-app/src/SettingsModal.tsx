import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { Modal } from "./Modal";
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
import { MemesButton } from "./MemesButton";
import { GgUiButton } from "./GgUiButton";
import { AppearanceSettings } from "./AppearanceSettings";

interface Props {
  onClose: () => void;
  /** Called with the saved projects root so callers can refresh. */
  onSaved?: (projectsRoot: string) => void;
  onAzureConnectionChanged?: () => void;
}

export function SettingsModal({
  onClose,
  onSaved,
  onAzureConnectionChanged,
}: Props): React.ReactElement {
  // Only the project folder is an explicitly saved field; Effects and
  // Appearance persist themselves the moment they change.
  const [projectsRoot, setProjectsRoot] = useState("");
  const [savedRoot, setSavedRoot] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null);
  const buildIdentity = formatBuildIdentity();
  const folderId = useId();
  const folderHintId = useId();
  const folderErrorId = useId();

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
    if (typeof picked === "string") setProjectsRoot(picked);
  }

  const trimmedRoot = projectsRoot.trim();
  const folderChanged = trimmedRoot !== "" && trimmedRoot !== savedRoot;

  async function save(): Promise<void> {
    if (!folderChanged || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      // Saved natively in Rust (writes ~/.gg/gg-app.json) — no sidecar round-trip,
      // so this works even while the sidecar is still booting or has crashed.
      await saveSettings(trimmedRoot);
      onSaved?.(trimmedRoot);
      onClose();
    } catch (e) {
      // Keep the modal and the typed folder so the user can retry or cancel.
      const reason = e instanceof Error ? e.message : String(e);
      setSaveError(`Couldn't save the project folder: ${reason}`);
      toast(`Couldn't save: ${reason}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Settings" onClose={onClose} className="settings-modal">
      {permissions?.applicable && (
        <>
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Permissions
          </div>
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
        </>
      )}
      <div className="modal-label" style={{ color: theme.textMuted }}>
        Effects
      </div>
      <div className="modal-hint" style={{ color: theme.textMuted }}>
        Applies immediately; Cancel does not undo it.
      </div>
      <div className="modal-row">
        <SoundButton variant="settings" />
        <MemesButton variant="settings" />
        <GgUiButton />
      </div>
      <label className="modal-label" htmlFor={folderId} style={{ color: theme.textMuted }}>
        Project folder
      </label>
      <div id={folderHintId} className="modal-hint" style={{ color: theme.textMuted }}>
        New projects are created inside this folder. Save folder and Cancel apply only to this
        field.
      </div>
      <div className="modal-row">
        <input
          id={folderId}
          className="modal-input"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={projectsRoot}
          placeholder="/Users/you/gg-projects"
          aria-describedby={saveError ? `${folderHintId} ${folderErrorId}` : folderHintId}
          aria-invalid={saveError ? true : undefined}
          onChange={(e) => {
            setProjectsRoot(e.target.value);
            setSaveError(null);
          }}
        />
        <button className="modal-btn" onClick={() => void browse()}>
          {"Browse\u2026"}
        </button>
      </div>
      {loadError && (
        <div className="modal-hint" style={{ color: theme.textMuted }}>
          {"Couldn\u2019t read the saved folder. Enter one and choose Save folder."}
        </div>
      )}
      {saveError && (
        <div id={folderErrorId} className="modal-hint" role="alert" style={{ color: theme.error }}>
          {saveError}
        </div>
      )}
      <AppearanceSettings />
      <AzureConnectionSettings onConnectionChanged={onAzureConnectionChanged} />
      {buildIdentity && (
        <div className="modal-build-identity" style={{ color: theme.textDim }}>
          {buildIdentity}
        </div>
      )}
      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="modal-btn primary"
          disabled={busy || !folderChanged}
          onClick={() => void save()}
        >
          {busy ? "Saving\u2026" : "Save folder"}
        </button>
      </div>
    </Modal>
  );
}
