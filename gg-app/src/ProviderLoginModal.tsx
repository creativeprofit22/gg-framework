import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { theme } from "./theme";
import { Modal } from "./Modal";
import {
  authApiKey,
  authOAuthStart,
  authOAuthCode,
  authLogout,
  subscribe,
  type AuthProvider,
  type AuthMethod,
  type SidecarEvent,
} from "./agent";

interface Props {
  provider: AuthProvider;
  onClose: () => void;
  /** Called after a successful connect/disconnect so the list can refresh. */
  onChanged: () => void;
}

/**
 * Per-provider login modal. Adapts to the provider's supported methods: a
 * method picker when both OAuth and API key are available, an API-key input,
 * or the interactive OAuth flow (opens the browser, collects a pasted code when
 * the provider needs one). Mirrors `ggcoder login`.
 */
export function ProviderLoginModal({ provider, onClose, onChanged }: Props): React.ReactElement {
  const single = provider.methods.length === 1 ? provider.methods[0] : null;
  const [method, setMethod] = useState<AuthMethod | null>(single);
  const [apiKey, setApiKey] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [codePrompt, setCodePrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen for OAuth progress events while this modal is open.
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        case "auth_url":
          setStatus("Opening your browser to continue…");
          void openUrl(String(d.url ?? ""));
          break;
        case "auth_status":
          setStatus(String(d.message ?? ""));
          break;
        case "auth_need_code":
          setNeedCode(true);
          setCodePrompt(String(d.message ?? "Paste the code from the browser:"));
          setStatus(null);
          break;
        case "auth_done":
          if (d.provider === provider.value) {
            setBusy(false);
            onChanged();
            onClose();
          }
          break;
        case "auth_error":
          if (d.provider === provider.value) {
            setBusy(false);
            setNeedCode(false);
            setError(String(d.message ?? "Login failed"));
            setStatus(null);
          }
          break;
      }
    });
    return () => unsub();
  }, [provider.value, onChanged, onClose]);

  async function submitApiKey(): Promise<void> {
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authApiKey(provider.value, apiKey.trim());
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function startOAuth(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus("Starting login…");
    try {
      await authOAuthStart(provider.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function submitCode(): Promise<void> {
    if (!code.trim()) return;
    setStatus("Verifying…");
    setNeedCode(false);
    try {
      await authOAuthCode(code.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function disconnect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await authLogout(provider.value);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const apiKeyLabel = provider.apiKeyLabel ?? provider.label;

  return (
    <Modal title={`Connect ${provider.label}`} onClose={onClose}>
      <div className="login-modal-desc">{provider.description}</div>

      {/* Method picker — only when the provider supports both. */}
      {!single && !method && (
        <div className="login-method-row">
          <button className="modal-btn primary" onClick={() => setMethod("oauth")}>
            Sign in with OAuth
          </button>
          <button className="modal-btn" onClick={() => setMethod("apikey")}>
            Use API key
          </button>
        </div>
      )}

      {/* API key entry. */}
      {method === "apikey" && (
        <>
          <div className="modal-label" style={{ color: theme.textMuted }}>
            {apiKeyLabel} API key
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground }}
            value={apiKey}
            type="password"
            placeholder="Paste your API key"
            autoFocus
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitApiKey();
            }}
          />
        </>
      )}

      {/* OAuth flow. */}
      {method === "oauth" && (
        <>
          {!busy && !status && (
            <div className="login-modal-desc">
              You'll be sent to {provider.label} in your browser to authorize access.
            </div>
          )}
          {needCode && (
            <>
              <div className="modal-label" style={{ color: theme.textMuted }}>
                {codePrompt}
              </div>
              <input
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={code}
                placeholder="Paste the code"
                autoFocus
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode();
                }}
              />
            </>
          )}
        </>
      )}

      {status && (
        <div className="login-status" style={{ color: theme.textMuted }}>
          {status}
        </div>
      )}
      {error && (
        <div className="login-status" style={{ color: theme.error }}>
          {error}
        </div>
      )}

      <div className="modal-actions">
        {provider.connected && (
          <button
            className="modal-btn"
            style={{ color: theme.error, marginRight: "auto" }}
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        )}
        <button className="modal-btn" onClick={onClose}>
          {needCode || busy ? "Cancel" : "Close"}
        </button>
        {method === "apikey" && (
          <button
            className="modal-btn primary"
            disabled={!apiKey.trim() || busy}
            onClick={() => void submitApiKey()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        )}
        {method === "oauth" && needCode && (
          <button
            className="modal-btn primary"
            disabled={!code.trim()}
            onClick={() => void submitCode()}
          >
            Submit
          </button>
        )}
        {method === "oauth" && !needCode && (
          <button className="modal-btn primary" disabled={busy} onClick={() => void startOAuth()}>
            {busy ? "Waiting…" : "Continue"}
          </button>
        )}
      </div>
    </Modal>
  );
}
