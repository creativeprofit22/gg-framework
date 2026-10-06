import { useEffect, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ListSkeleton } from "./Skeleton";
import {
  hfPull,
  hfPullCancel,
  hfPullStatus,
  hfSearch,
  isHfPullEvent,
  subscribe,
  type HfPullState,
  type HfSearchResult,
  type SidecarEvent,
} from "./agent";

interface Props {
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString("en-US");
}

/**
 * Search Hugging Face and pull a model through Ollama, all in one modal:
 * type, pick from the live dropdown, and the download starts. Pull state lives
 * in the sidecar, so closing this modal mid-download never cancels it —
 * reopening (or any later open) reattaches to the running pull.
 */
export function HfPullModal({ onClose }: Props): React.ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HfSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [pull, setPull] = useState<HfPullState | null>(null);
  const [starting, setStarting] = useState(false);

  // Adopt a still-running pull (opened mid-download), but never a finished one
  // from a previous session with this modal.
  useEffect(() => {
    let cancelled = false;
    void hfPullStatus().then((state) => {
      if (cancelled) return;
      if (state && state.phase !== "success" && state.phase !== "error") setPull(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Progress while this modal is open (works for pulls started elsewhere too).
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      if (isHfPullEvent(e)) setPull(e.data);
    });
    return () => unsub();
  }, []);

  // Debounced search: nothing under 2 chars, and a stale response for an older
  // query must never overwrite a newer one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    let live = true;
    const timer = setTimeout(() => {
      void hfSearch(q)
        .then((rows) => {
          if (!live) return;
          setResults(rows);
          setHighlight(0);
          setSearchError(null);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setResults([]);
          setSearchError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query]);

  async function start(repo: string): Promise<void> {
    if (starting) return;
    setStarting(true);
    setSearchError(null);
    try {
      setPull(await hfPull(repo));
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!results || results.length === 0 || pull) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void start(results[highlight].id);
    }
  }

  const installing = pull !== null && pull.phase !== "success" && pull.phase !== "error";
  const done = pull?.phase === "success";
  const failed = pull?.phase === "error";

  return (
    <Modal title="Add a Hugging Face model" onClose={onClose} className="hf-modal">
      {!pull && (
        <>
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Search Hugging Face, then pick a model to download with Ollama.
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={query}
            placeholder="qwen3 coder, smollm2, llama…"
            autoFocus
            role="combobox"
            aria-expanded={results !== null && results.length > 0}
            aria-controls="hf-search-results"
            aria-activedescendant={
              results && results.length > 0 ? `hf-result-${highlight}` : undefined
            }
            aria-autocomplete="list"
            aria-label="Search Hugging Face models"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />

          {searching && <ListSkeleton rows={3} />}

          {!searching && searchError && (
            <div className="login-status" style={{ color: theme.error }} role="alert">
              {searchError}
            </div>
          )}

          {!searching && results && results.length === 0 && !searchError && (
            <div className="hf-empty" style={{ color: theme.textDim }}>
              No GGUF models matched. Try a shorter search.
            </div>
          )}

          {!searching && results && results.length > 0 && (
            <ul
              id="hf-search-results"
              role="listbox"
              aria-label="Hugging Face models"
              className="hf-results"
            >
              {results.map((r, i) => (
                <li
                  key={r.id}
                  id={`hf-result-${i}`}
                  role="option"
                  aria-selected={i === highlight}
                  className="hf-result"
                  style={{
                    borderColor: i === highlight ? theme.borderStrong : "transparent",
                    color: theme.text,
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => void start(r.id)}
                >
                  <span className="hf-result-name">{r.id}</span>
                  <span className="hf-result-meta" style={{ color: theme.textDim }}>
                    {formatCount(r.downloads)} downloads · {formatCount(r.likes)} likes
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!searching && starting && (
            <div className="login-status" style={{ color: theme.textMuted }}>
              Starting download…
            </div>
          )}
        </>
      )}

      {pull && (
        <div aria-live="polite">
          <div className="hf-install-name" style={{ color: theme.text }}>
            {pull.model}
          </div>
          <div className="hf-install-sub" style={{ color: theme.textDim }}>
            {pull.sizeBytes > 0 ? `${formatSize(pull.sizeBytes)} · ` : ""}
            {pull.tag ? `${pull.tag} quant` : "default file"}
          </div>

          {installing && (
            <>
              <div
                className="hf-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pull.percent)}
                aria-label={`Downloading ${pull.model}`}
                style={{ background: theme.inputBackground }}
              >
                <div
                  className="hf-progress-fill"
                  style={{ width: `${Math.min(100, Math.max(2, pull.percent))}%` }}
                />
              </div>
              <div className="hf-progress-line" style={{ color: theme.textMuted }}>
                {pull.phase === "preparing" && "Contacting Ollama…"}
                {pull.phase === "downloading" &&
                  (pull.detail?.trim() || `${Math.round(pull.percent)}% downloaded`)}
                {pull.phase === "verifying" && "Verifying download…"}
              </div>
            </>
          )}

          {done && (
            <div className="login-status" style={{ color: theme.success }}>
              Installed. It's in Ollama, ready to pick in the model selector.
            </div>
          )}

          {failed && (
            <div className="login-status" style={{ color: theme.error }} role="alert">
              {pull.error ?? "The download failed."}
            </div>
          )}
        </div>
      )}

      <div className="modal-actions">
        {installing && (
          <button
            className="modal-btn"
            style={{ marginRight: "auto", color: theme.error }}
            onClick={() => void hfPullCancel()}
          >
            Cancel download
          </button>
        )}
        {(done || failed) && (
          <button
            className="modal-btn"
            style={{ marginRight: "auto" }}
            onClick={() => {
              setPull(null);
              setQuery("");
              setResults(null);
            }}
          >
            Download another
          </button>
        )}
        <button className="modal-btn" onClick={onClose}>
          {done ? "Done" : installing ? "Hide" : "Close"}
        </button>
      </div>
    </Modal>
  );
}
