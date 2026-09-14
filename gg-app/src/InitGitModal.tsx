import { useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import {
  DEFAULT_GIT_BOOTSTRAP_OPTIONS,
  buildGitBootstrapPrompt,
  type GitBootstrapOptions,
} from "./init-git-prompt";

interface Props {
  /** Default repository name (e.g. the project folder name). */
  defaultName: string;
  onClose: () => void;
  /** Called with the assembled instruction for the agent to act on. */
  onInitialize: (prompt: string) => void;
}

type Visibility = "private" | "public";

/** Normalize freeform input toward a valid GitHub repo name. */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Collects everything the agent needs to initialize git + create a remote in
 * one pass (visibility + repo name + bootstrap toggles), so the agent never has
 * to stop and ask the user mid-run. On Initialize we hand a single complete
 * instruction to the existing prompt path.
 *
 * The CI/protection/AGENTS.md steps are generated, not copied from GitHub's
 * starter workflows — those are stale and unhardened (no permissions,
 * no concurrency, no timeouts, naive matrices). The agent detects the stack
 * from manifests on disk and emits the cheap-by-construction variant:
 * one Linux job, least-privilege token, stale-run cancellation, hard timeout.
 */
export function InitGitModal({ defaultName, onClose, onInitialize }: Props): React.ReactElement {
  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [options, setOptions] = useState<GitBootstrapOptions>(DEFAULT_GIT_BOOTSTRAP_OPTIONS);

  const slug = slugify(name);
  const canInit = slug.length > 0;

  function toggle(key: keyof GitBootstrapOptions): void {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function initialize(): void {
    if (!canInit) return;
    onInitialize(buildGitBootstrapPrompt({ slug, visibility, options }));
  }

  const bootstrapToggles: Array<{ key: keyof GitBootstrapOptions; label: string }> = [
    { key: "ci", label: "CI workflow + Dependabot" },
    { key: "protection", label: "Branch protection" },
    { key: "agents", label: "AGENTS.md" },
  ];

  return (
    <Modal title="Initialize Git" onClose={onClose}>
      <div className="modal-hint" style={{ color: theme.textSecondary }}>
        Sets up git for this project, creates a GitHub repository, and configures CI for its stack.
      </div>

      <label className="modal-label" style={{ color: theme.textMuted }}>
        Repository name
      </label>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={name}
        placeholder="my-project"
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") initialize();
        }}
      />
      {slug !== name.trim() && slug.length > 0 && (
        <div className="modal-hint" style={{ color: theme.textDim }}>
          Will use <span style={{ color: theme.textMuted }}>{slug}</span>
        </div>
      )}

      <label className="modal-label" style={{ color: theme.textMuted }}>
        Visibility
      </label>
      <div className="modal-radio-group">
        {(["private", "public"] as Visibility[]).map((v) => (
          <label
            key={v}
            className="modal-radio"
            style={{ color: visibility === v ? theme.text : theme.textMuted }}
          >
            <input
              type="radio"
              name="git-visibility"
              checked={visibility === v}
              onChange={() => setVisibility(v)}
            />
            <span style={{ textTransform: "capitalize" }}>{v}</span>
          </label>
        ))}
      </div>

      <label className="modal-label" style={{ color: theme.textMuted }}>
        Also set up
      </label>
      <div className="modal-radio-group">
        {bootstrapToggles.map(({ key, label }) => (
          <label
            key={key}
            className="modal-radio"
            style={{ color: options[key] ? theme.text : theme.textMuted }}
          >
            <input type="checkbox" checked={options[key]} onChange={() => toggle(key)} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="modal-btn primary" disabled={!canInit} onClick={initialize}>
          Initialize
        </button>
      </div>
    </Modal>
  );
}
