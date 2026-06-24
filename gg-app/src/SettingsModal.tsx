import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { getSettings, saveSettings } from "./agent";
import { toast } from "./toast";

interface Props {
  onClose: () => void;
  /** Called with the saved projects root so callers can refresh. */
  onSaved?: (projectsRoot: string) => void;
}

export function SettingsModal({ onClose, onSaved }: Props): React.ReactElement {
  const [projectsRoot, setProjectsRoot] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Native (Rust) read — no sidecar wait needed.
    void getSettings()
      .then((s) => {
        if (s) setProjectsRoot(s.projectsRoot);
      })
      .catch(() => {});
  }, []);

  async function browse(): Promise<void> {
    const picked = await open({ directory: true, multiple: false, title: "Projects folder" });
    if (typeof picked === "string") setProjectsRoot(picked);
  }

  async function save(): Promise<void> {
    if (!projectsRoot.trim() || busy) return;
    setBusy(true);
    try {
      // Saved natively in Rust (writes ~/.gg/gg-app.json) — no sidecar round-trip,
      // so this works even while the sidecar is still booting or has crashed.
      await saveSettings(projectsRoot.trim());
      onSaved?.(projectsRoot.trim());
      onClose();
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="modal-label" style={{ color: theme.textMuted }}>
        Project folder
      </div>
      <div className="modal-hint" style={{ color: theme.textDim }}>
        New projects are created inside this folder.
      </div>
      <div className="modal-row">
        <input
          className="modal-input"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={projectsRoot}
          placeholder="C:\\Users\\you\\Projects"
          onChange={(e) => setProjectsRoot(e.target.value)}
        />
        <button className="modal-btn" onClick={() => void browse()}>
          {"Browse\u2026"}
        </button>
      </div>
      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="modal-btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
