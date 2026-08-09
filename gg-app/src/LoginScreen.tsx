import { useCallback, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { theme } from "./theme";
import { authStatus, subscribe, type AuthProvider, type SidecarEvent } from "./agent";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ProviderLoginModal } from "./ProviderLoginModal";
import { LocalModelsModal } from "./LocalModelsModal";
import { providerLogo } from "./provider-logos";

interface Props {
  onClose: () => void;
}

/**
 * Provider login hub. Shows every supported AI provider as a grid of logo
 * tiles with a live connection dot; selecting one opens a modal that adapts
 * to OAuth, API key, or both. Mirrors `ggcoder login` in the desktop app.
 */
export function LoginScreen({ onClose }: Props): React.ReactElement {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<AuthProvider | null>(null);
  const [localOpen, setLocalOpen] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await authStatus();
    setProviders(list);
    setLoading(false);
    // Keep the open modal's `connected` flag in sync after a change.
    setActive((cur) => (cur ? (list.find((p) => p.value === cur.value) ?? cur) : cur));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Auth status is read natively (Rust) — no sidecar wait, so the list renders
    // immediately even while the agent is still booting or has crashed.
    void authStatus()
      .then((list) => {
        if (!cancelled) {
          setProviders(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ~/.gg/auth.json is shared by every window, so connecting or disconnecting
  // anywhere changes what THIS screen should show. `auth_change` covers both
  // directions (unlike `auth_done`, which only means a login succeeded);
  // without re-reading here the connection dots and the "N connected" badge
  // stay stale until the screen is reopened.
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      if (e.type === "auth_change") void refresh();
    });
    return () => unsub();
  }, [refresh]);

  const connectedCount = providers.filter((p) => p.connected).length;

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
        <span className="picker-title">AI Providers</span>
        {!loading && (
          <Badge color={connectedCount > 0 ? theme.success : undefined}>
            {`${connectedCount} connected`}
          </Badge>
        )}
      </div>

      <div className="login-scroll">
        <div className="login-grid">
          {loading && (
            <div className="picker-empty" style={{ color: theme.textDim }}>
              {"checking providers\u2026"}
            </div>
          )}
          {providers.map((p) => {
            const logo = providerLogo(p.value);
            return (
              <button key={p.value} className="login-tile" onClick={() => setActive(p)}>
                {p.connected && (
                  <span className="login-conn-dot" title="Connected" aria-label="Connected" />
                )}
                <span className="login-tile-logo">
                  {logo ? (
                    <img className="login-logo" src={logo} alt="" />
                  ) : (
                    <span className="login-logo-fallback">{p.label.charAt(0)}</span>
                  )}
                </span>
                <span className="login-tile-name">{p.label}</span>
                <span className="login-tile-methods">
                  {p.methods.map((m) => {
                    // Providers can support two methods and have BOTH connected, so
                    // colour each badge by its own state instead of the tile's one
                    // dot: green = this credential is on file. The dot above still
                    // answers "is this provider usable at all".
                    const isConnected = (p.connectedMethods ?? []).includes(m);
                    const isActive = p.activeMethod === m;
                    const label = m === "oauth" ? "OAuth" : "API key";
                    return (
                      <Badge
                        key={m}
                        color={isConnected ? theme.success : undefined}
                        title={
                          isConnected
                            ? isActive
                              ? `${label} — connected, in use`
                              : `${label} — connected, standby`
                            : `${label} — not connected`
                        }
                      >
                        {label}
                      </Badge>
                    );
                  })}
                </span>
              </button>
            );
          })}
          {/* Local models aren't a provider you log into — they're whatever the
              user already runs. Same tile shape so the hub stays one grid. */}
          {!loading && (
            <button
              className="login-tile"
              onClick={() => setLocalOpen(true)}
              title="Ollama, LM Studio, llama.cpp, vLLM — running on this machine"
            >
              {/* A chip, not a house: these models run on this machine's own
                  hardware. Sized to fill the 48px logo box like the provider
                  logos, instead of a glyph sized for a single letter. */}
              <span className="login-tile-logo">
                <Cpu size={44} strokeWidth={1.25} color={theme.text} aria-hidden="true" />
              </span>
              <span className="login-tile-name">Local models</span>
              <span className="login-tile-methods">
                <Badge>No key needed</Badge>
              </span>
            </button>
          )}
        </div>
      </div>

      {active && (
        <ProviderLoginModal
          provider={active}
          onClose={() => setActive(null)}
          onChanged={() => void refresh()}
        />
      )}

      {localOpen && <LocalModelsModal onClose={() => setLocalOpen(false)} />}
    </div>
  );
}
