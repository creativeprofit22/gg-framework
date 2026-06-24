import { useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { createProject, selectProject } from "./agent";

interface Props {
  /** Where new projects are created — shown so the user knows the destination. */
  projectsRoot: string;
  onClose: () => void;
  /** Called after the project is created + this window re-pointed at it. */
  onCreated: (cwd: string) => void;
}

/** Normalize freeform input toward a valid folder name (lowercase, dashes). */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function NewProjectModal({ projectsRoot, onClose, onCreated }: Props): React.ReactElement {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugify(name);
  const canCreate = slug.length > 0 && !busy;

  async function create(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const cwd = await createProject(slug);
      await selectProject(cwd);
      onCreated(cwd);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={name}
        placeholder="my-project"
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
        }}
      />
      <div className="modal-hint" style={{ color: theme.textDim }}>
        Creates{" "}
        <span style={{ color: theme.textMuted }}>
          {projectsRoot}/{slug || "\u2026"}
        </span>
      </div>
      {error && (
        <div className="modal-error" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="modal-btn primary" disabled={!canCreate} onClick={() => void create()}>
          {busy ? "Creating\u2026" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
