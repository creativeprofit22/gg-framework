import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ListSkeleton } from "./Skeleton";
import {
  addLocalEndpoint,
  getLocalModels,
  removeLocalEndpoint,
  scanLocalModels,
  type LocalEndpointRow,
  type LocalModelRow,
} from "./agent";
import { toast } from "./toast";

interface Props {
  onClose: () => void;
}

function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** The one figure worth showing inline. "?" = the server never reported it. */
function contextLabel(model: LocalModelRow): string {
  return model.contextWindowKnown
    ? `${formatContext(model.contextWindow)} ctx`
    : `${formatContext(model.contextWindow)} ctx?`;
}

/**
 * Everything the row can't show: which endpoint serves it, the exact context
 * length, capabilities, load state, and — for a model that can't run the agent
 * — why it's disabled.
 */
function modelTooltip(model: LocalModelRow, endpointLabel: string): string {
  const lines = [`${model.rawId} — ${endpointLabel}`];
  lines.push(
    model.contextWindowKnown
      ? `Context: ${model.contextWindow.toLocaleString()} tokens`
      : `Context: unknown — assuming ${model.contextWindow.toLocaleString()} tokens`,
  );
  const caps: string[] = [];
  if (model.supportsTools) caps.push("tool calling");
  if (model.supportsImages) caps.push("vision");
  if (model.supportsThinking) caps.push("thinking");
  lines.push(caps.length > 0 ? `Supports: ${caps.join(", ")}` : "Supports: text only");
  if (model.loaded) lines.push("Loaded in memory");
  if (!model.supportsTools) {
    lines.push("Can't run the agent — this model has no tool calling.");
  }
  return lines.join("\n");
}

/**
 * Local endpoint manager — which servers are running on this machine and what
 * they serve. Ollama, LM Studio, llama.cpp and vLLM are probed on their
 * documented default ports without any setup; "Add endpoint" covers a moved port
 * or a self-hosted box.
 *
 * Read-only by design: models are **chosen in the footer model selector** like
 * every other model, so there's exactly one selection surface in the app. This
 * screen answers "is my server up, and what can these models do" — capabilities
 * come from each server rather than from guesses, so a model that can't call
 * tools is flagged here instead of failing on the first prompt.
 */
export function LocalModelsModal({ onClose }: Props): React.ReactElement {
  const [endpoints, setEndpoints] = useState<LocalEndpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Show the last scan immediately (no probing), then refresh in the background
  // so a server started since the app booted appears without a manual scan.
  useEffect(() => {
    let cancelled = false;
    void getLocalModels()
      .then((state) => {
        if (cancelled) return;
        setEndpoints(state.endpoints);
        setLoading(false);
        return scanLocalModels();
      })
      .then((state) => {
        if (!cancelled && state) setEndpoints(state.endpoints);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      const state = await scanLocalModels();
      setEndpoints(state.endpoints);
      const found = state.endpoints.reduce((total, e) => total + e.models.length, 0);
      toast(
        found === 0
          ? "No local models found. Start Ollama or LM Studio and scan again."
          : `Found ${found} local model${found === 1 ? "" : "s"}.`,
        found === 0 ? "warning" : "success",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setScanning(false);
    }
  }, []);

  async function add(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setAddError(null);
    try {
      const state = await addLocalEndpoint(url, label.trim() || undefined, apiKey || undefined);
      setEndpoints(state.endpoints);
      setUrl("");
      setLabel("");
      setApiKey("");
      setShowAdd(false);
      toast("Endpoint added.", "success");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(endpoint: LocalEndpointRow): Promise<void> {
    try {
      const state = await removeLocalEndpoint(endpoint.id);
      setEndpoints(state.endpoints);
      toast(`Removed "${endpoint.label}".`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  const totalModels = endpoints.reduce((total, e) => total + e.models.length, 0);

  return (
    <Modal title="Local models" onClose={onClose}>
      {/* The "nothing found" line belongs with the instruction that fixes it,
          above the endpoint rows — not stranded at the bottom of a scroll area
          the user has to reach to learn why the list looks empty. */}
      {!loading && totalModels === 0 && (
        <div className="mcp-empty" style={{ color: theme.textMuted, marginBottom: 6 }}>
          No local models yet. Start Ollama (or LM Studio) and scan.
        </div>
      )}

      {loading ? (
        <ListSkeleton rows={4} />
      ) : (
        <div className="mcp-list">
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} style={{ marginBottom: 10 }}>
              <div className="mcp-item">
                <span
                  className="mcp-dot"
                  style={{ color: endpoint.reachable ? theme.success : theme.textDim }}
                  aria-hidden="true"
                >
                  {endpoint.reachable ? "\u25cf" : "\u25cb"}
                </span>
                <span className="mcp-name" style={{ color: theme.text }} title={endpoint.baseUrl}>
                  {endpoint.label}
                </span>
                <span className="mcp-meta" style={{ color: theme.textDim }}>
                  {endpoint.reachable
                    ? `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}`
                    : (endpoint.reason ?? "not running")}
                </span>
                {endpoint.custom && (
                  <button
                    className="mcp-delete"
                    style={{ color: theme.textDim }}
                    title={`Remove "${endpoint.label}"`}
                    onClick={() => void remove(endpoint)}
                  >
                    {"\u00d7"}
                  </button>
                )}
              </div>

              {endpoint.models.map((model) => (
                // Informational row, not a control: selection happens in the
                // footer model selector. A row is too narrow for a chip per
                // capability (they overflowed the modal), so one quiet context
                // figure sits inline and the full detail is in the tooltip.
                <div
                  key={model.id}
                  className="local-model-row"
                  style={{ color: model.supportsTools ? theme.text : theme.textDim }}
                  title={modelTooltip(model, endpoint.label)}
                >
                  <span className="local-model-name">{model.rawId}</span>
                  <span className="local-model-meta" style={{ color: theme.textDim }}>
                    {model.supportsTools ? contextLabel(model) : "no tool calling"}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {showAdd ? (
        <>
          <div className="modal-label" style={{ color: theme.textMuted, marginTop: 4 }}>
            Endpoint URL
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={url}
            placeholder="http://127.0.0.1:11434/v1"
            autoFocus
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Name (optional)
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={label}
            placeholder="Workstation"
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="modal-label" style={{ color: theme.textMuted }}>
            API key (optional)
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={apiKey}
            type="password"
            placeholder="Only if your server requires one"
            onChange={(e) => setApiKey(e.target.value)}
          />
          {addError && (
            <div className="login-status" style={{ color: theme.error }}>
              {addError}
            </div>
          )}
        </>
      ) : (
        /* `.modal-hint` sets word-break: break-all (it's shared with URL and
           path hints); this is prose, so break on word boundaries instead. */
        <div
          className="modal-hint"
          style={{
            color: theme.textDim,
            marginTop: 12,
            wordBreak: "normal",
            overflowWrap: "break-word",
          }}
        >
          Pick a local model from the model selector at the bottom of the window. Models with no
          tool calling can’t run the agent. A “?” on the context size means the server didn’t report
          one.
        </div>
      )}

      <div className="modal-actions">
        <button
          className="modal-btn"
          style={{ marginRight: "auto" }}
          onClick={() => {
            setAddError(null);
            setShowAdd((current) => !current);
          }}
        >
          {showAdd ? "Cancel" : "Add endpoint"}
        </button>
        {showAdd ? (
          <button
            className="modal-btn primary"
            disabled={!url.trim() || busy}
            onClick={() => void add()}
          >
            {busy ? "Saving\u2026" : "Save"}
          </button>
        ) : (
          <>
            <button className="modal-btn" onClick={onClose}>
              Close
            </button>
            <button
              className="modal-btn primary"
              disabled={scanning}
              onClick={() => void scan()}
              title="Re-check every local endpoint"
            >
              <RefreshCw size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {scanning ? "Scanning\u2026" : "Scan"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
