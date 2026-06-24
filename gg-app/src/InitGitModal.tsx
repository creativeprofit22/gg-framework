import { useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";

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
 * one pass (visibility + repo name), so the agent never has to stop and ask the
 * user mid-run. On Initialize we hand a single complete instruction to the
 * existing prompt path.
 */
export function InitGitModal({ defaultName, onClose, onInitialize }: Props): React.ReactElement {
  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<Visibility>("private");

  const slug = slugify(name);
  const canInit = slug.length > 0;

  function initialize(): void {
    if (!canInit) return;
    const prompt =
      `Initialize git for this project and publish it to GitHub.\n\n` +
      `Use these settings:\n` +
      `- Repository name: ${slug}\n` +
      `- Visibility: ${visibility}\n\n` +
      `Steps:\n` +
      `1. Run \`git init\` if the project is not already a git repository.\n` +
      `2. Create a sensible .gitignore for this project's stack if one doesn't exist.\n` +
      `3. Stage all files and make an initial commit with a clear message.\n` +
      `4. Create the GitHub repository "${slug}" as ${visibility} using the \`gh\` CLI ` +
      `(\`gh repo create ${slug} --${visibility} --source=. --remote=origin --push\`). ` +
      `If \`gh\` is unavailable or not authenticated, stop and tell the user how to install/auth it.\n` +
      `5. Push the initial commit to the new remote.\n\n` +
      `Do not ask me any follow-up questions — use the settings above and complete it end to end.`;
    onInitialize(prompt);
  }

  return (
    <Modal title="Initialize Git" onClose={onClose}>
      <div className="modal-hint" style={{ color: theme.textSecondary }}>
        Sets up git for this project and creates a GitHub repository.
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
