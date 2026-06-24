import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { waitForReady, getTelegramStatus, saveTelegramConfig } from "./agent";
import { toast } from "./toast";

interface Props {
  onClose: () => void;
  /** Called after a successful save so the caller can refresh serve state. */
  onSaved?: () => void;
}

/**
 * Telegram bot setup — mirrors `ggcoder telegram`. Collects a BotFather token
 * and the authorized numeric user id, verifies the token sidecar-side (getMe),
 * and saves to ~/.gg/telegram.json. The token field is left blank when one is
 * already saved (a masked preview is shown instead).
 */
export function TelegramSettingsModal({ onClose, onSaved }: Props): React.ReactElement {
  const [botToken, setBotToken] = useState("");
  const [userId, setUserId] = useState("");
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void waitForReady()
      .then(() => getTelegramStatus())
      .then((s) => {
        if (s.configured) {
          if (s.userId) setUserId(String(s.userId));
          if (s.tokenPreview) setTokenPreview(s.tokenPreview);
        }
      })
      .catch(() => {});
  }, []);

  const canSave = (botToken.trim().length > 0 || tokenPreview !== null) && userId.trim().length > 0;

  async function save(): Promise<void> {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveTelegramConfig(botToken.trim(), userId.trim());
      onSaved?.();
      toast("Telegram connected.", "success");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function link(url: string, label: string): React.ReactElement {
    return (
      <a
        className="home-link"
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void openUrl(url);
        }}
      >
        {label}
      </a>
    );
  }

  return (
    <Modal title="Telegram setup" onClose={onClose}>
      <div className="modal-label" style={{ color: theme.textMuted }}>
        Bot token
      </div>
      <div className="modal-hint" style={{ color: theme.textDim }}>
        Create a bot with {link("https://t.me/BotFather", "@BotFather")} (/newbot), then paste its
        token.
      </div>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={botToken}
        placeholder={
          tokenPreview ? `Saved (${tokenPreview}) — leave blank to keep` : "123456789:ABCdef…"
        }
        autoFocus
        onChange={(e) => setBotToken(e.target.value)}
      />

      <div className="modal-label" style={{ color: theme.textMuted, marginTop: 14 }}>
        Your Telegram user ID
      </div>
      <div className="modal-hint" style={{ color: theme.textDim }}>
        Message {link("https://t.me/userinfobot", "@userinfobot")} for your ID.
      </div>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={userId}
        placeholder="123456789"
        inputMode="numeric"
        onChange={(e) => setUserId(e.target.value.replace(/[^0-9]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />

      {error && (
        <div className="modal-error" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="modal-btn primary"
          disabled={!canSave || busy}
          onClick={() => void save()}
        >
          {busy ? "Verifying\u2026" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
