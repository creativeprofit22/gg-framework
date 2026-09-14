/**
 * Hugging Face → Ollama pull pipeline (pure helpers).
 *
 * The sidecar's `/hf/*` routes (app-sidecar.ts) use these to search the Hub,
 * pick a quantized GGUF variant, and stream `ollama pull hf.co/<repo>:<quant>`
 * progress to the app. Kept dependency-free and side-effect-free so the
 * parsing/selection rules are unit-testable.
 */

/** `org/repo` only — no tags, no traversal, no leading slashes. */
export function isValidHfRepoId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

export interface HfSearchRow {
  id: string;
  downloads: number;
  likes: number;
  updatedAt: string | null;
}

/**
 * Map a Hub `/api/models?search=` result entry to what the dropdown shows.
 * Entries without parsed `gguf` metadata are dropped: the Hub tags plenty of
 * safetensors-only repos as GGUF-adjacent, and those can never be pulled.
 */
export function toHfSearchRow(entry: {
  id?: unknown;
  downloads?: unknown;
  likes?: unknown;
  lastModified?: unknown;
  gguf?: unknown;
}): HfSearchRow | null {
  if (typeof entry.id !== "string" || !isValidHfRepoId(entry.id)) return null;
  if (entry.gguf === undefined || entry.gguf === null) return null;
  return {
    id: entry.id,
    downloads: typeof entry.downloads === "number" && entry.downloads > 0 ? entry.downloads : 0,
    likes: typeof entry.likes === "number" && entry.likes > 0 ? entry.likes : 0,
    updatedAt: typeof entry.lastModified === "string" ? entry.lastModified : null,
  };
}

export interface GgufFile {
  /** Filename, e.g. `qwen3-coder-30b-q4_k_m.gguf`. */
  path: string;
  sizeBytes: number;
}

export interface QuantChoice {
  /** Ollama tag for `hf.co/<repo>:<tag>` — `Q4_K_M`, or null to pull tagless. */
  tag: string | null;
  file: GgufFile;
}

/** Preference order: best quality-per-byte first, the community default. */
const QUANT_PREFERENCE = ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "Q6_K", "Q8_0", "Q3_K_M"];

/** Quant token from a GGUF filename (`...-q4_k_m.gguf` → `Q4_K_M`), if any. */
export function quantFromFilename(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const match = /[-.]((?:i|t)?q\d[_a-z0-9]*)\.gguf$/i.exec(base);
  return match ? match[1].toUpperCase() : null;
}

/**
 * `...-00001-of-00009.gguf` — a shard of a split model. Ollama's registry
 * cannot pull sharded GGUF (ollama/ollama#5245), so these are never candidates.
 */
export function isGgufShard(path: string): boolean {
  return /-\d{4,5}-of-\d{4,5}\.gguf$/i.test(path.split("/").pop() ?? path);
}

/**
 * GGUF files in a model repo that are not the model:
 *
 * - `mmproj-*` / `*projector*` — vision projectors, loaded alongside weights.
 * - `imatrix*` — quantization calibration data.
 * - `mtp-*` / `dspark-*` / anything under `MTP/` — tiny speculative-decoding
 *   draft models.
 *
 * All three would otherwise be installed *as* the model: projectors are the
 * smallest file (winning the size fallback) and drafts often carry a more
 * preferred quant tag than the real weights (`mtp-…-Q4_0.gguf` beside
 * `…-qat-UD-Q4_K_XL.gguf`).
 *
 * simplification: matched by name, since size does not separate them — across
 * the top GGUF repos, drafts run 6–23% of the largest file while legitimate
 * IQ1/IQ2 quants run 8–13%. Ceiling: a vendor inventing a new draft prefix is
 * missed until it is added here. Upgrade path: the Hub's per-file `gguf`
 * metadata exposes parameter counts, which separate drafts from quants exactly.
 */
export function isGgufCompanion(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const base = segments.pop() ?? path.toLowerCase();
  if (segments.includes("mtp")) return true;
  // `mmproj` appears mid-name too (`llava-…-mmproj-f16.gguf`). The rest are
  // anchored: `DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf` is a real model, and
  // `…-IQ4_XS-imat.gguf` is a real imatrix-*quantized* model.
  return (
    base.includes("mmproj") ||
    base.includes("projector") ||
    base.startsWith("imatrix") ||
    base.startsWith("mtp-") ||
    base.startsWith("dspark-")
  );
}

/** Every pullable GGUF in a repo tree: real models, no shards, no companions. */
export function ggufCandidates(files: readonly GgufFile[]): GgufFile[] {
  return files.filter(
    (f) =>
      f.path.toLowerCase().endsWith(".gguf") && !isGgufShard(f.path) && !isGgufCompanion(f.path),
  );
}

/**
 * Pick which GGUF file `ollama pull` should fetch. Deterministic: the first
 * entry of `QUANT_PREFERENCE` present, else the smallest file (multi-quant
 * repos list big quants first), else the only file — tagless when the repo
 * ships a single unnamed GGUF.
 */
export function pickGgufQuant(files: readonly GgufFile[]): QuantChoice | null {
  const ggufs = ggufCandidates(files);
  if (ggufs.length === 0) return null;
  for (const quant of QUANT_PREFERENCE) {
    const hit = ggufs.find((f) => quantFromFilename(f.path) === quant);
    if (hit) return { tag: quant, file: hit };
  }
  const smallest = ggufs.reduce((a, b) => (a.sizeBytes <= b.sizeBytes ? a : b));
  return { tag: quantFromFilename(smallest.path), file: smallest };
}

/** Shown when a repo only ships split GGUF shards — an Ollama limitation. */
export const SHARDED_MESSAGE =
  "That repo only ships split GGUF shards, which Ollama can't pull. Pick a repo with single-file quants (bartowski, lmstudio-community, or the non-split unsloth build).";

export type PullPhase = "preparing" | "downloading" | "verifying" | "success" | "error";

/**
 * A pull only moves forward. ollama redraws a multi-line TUI frame, so a single
 * chunk carries both `pulling manifest` and the live progress line — applied in
 * order that flipped the modal preparing→downloading→preparing several times a
 * second, which is the flicker. Ranked so a stale line can never win.
 */
const PHASE_ORDER: Record<PullPhase, number> = {
  preparing: 0,
  downloading: 1,
  verifying: 2,
  success: 3,
  error: 4,
};

/** True when `next` is a real step forward from `current` (never backwards). */
export function advancesPhase(current: PullPhase, next: PullPhase): boolean {
  return PHASE_ORDER[next] >= PHASE_ORDER[current];
}

export interface PullProgress {
  phase: PullPhase;
  /** 0-100 while downloading; sticky afterwards. */
  percent?: number;
  /** Display text, e.g. `161 MB / 18 GB · 11 MB/s · 26m8s`. */
  detail?: string;
}

/** Strip terminal control noise (cursor moves, enable/disable, spinner
 *  frames) that ollama emits even when piped, so lines stay readable. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const ANSI_NOISE = /\u001b\[[0-9;?]*[A-Za-z]|[\u001b\u0000-\u0008\u000b-\u001f]|[\u2800-\u28ff]/g;

/** `1.2 GB`, `505 KB`, `18 GB` — ollama pads the number, so allow inner spaces. */
const SIZE = String.raw`\d[\d.]*\s*[KMGT]?B`;
const TRANSFER = new RegExp(String.raw`(${SIZE})\s*/\s*(${SIZE})`);
const RATE = new RegExp(String.raw`(${SIZE}/s)`);
/** Trailing `26m8s` / `6s` / `1h2m3s`, before any glued-on next frame. */
const ETA = /(?:\d+h)?(?:\d+m)?\d+s(?=\D|$)/;

/**
 * Build the one-line status under the bar. Fixed field order and no ASCII art,
 * so consecutive frames differ only in their numbers — ollama's own rendering
 * is a redrawn TUI frame (progress bar glyphs, cursor-up, the next frame's text
 * glued onto the same line) that reflowed and flickered when shown verbatim.
 */
function formatTransfer(text: string): string | undefined {
  const transfer = TRANSFER.exec(text);
  if (!transfer) return undefined;
  const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
  const parts = [`${tidy(transfer[1])} / ${tidy(transfer[2])}`];
  // Search after the transferred/total pair so `18 GB` can't be read as a rate
  // and the ETA can't match digits inside the sizes.
  const rest = text.slice(transfer.index + transfer[0].length);
  const rate = RATE.exec(rest);
  if (rate) parts.push(tidy(rate[1]));
  const eta = ETA.exec(rate ? rest.slice(rate.index + rate[0].length) : rest);
  if (eta) parts.push(eta[0]);
  return parts.join(" · ");
}

/**
 * Parse one non-TTY `ollama pull` line. The CLI prints status verbs plus
 * `<sha>: <pct>% <done>/<total> <rate>` lines to stderr; any unrecognized line
 * is still surfaced as `downloading` with the raw text so the UI never stalls
 * silently behind a parser gap.
 */
export function parseOllamaPullLine(line: string): PullProgress | null {
  const text = line.replace(ANSI_NOISE, "").trim();
  if (!text) return null;
  if (text === "success") return { phase: "success", percent: 100 };
  if (text.startsWith("verifying") || text.startsWith("writing manifest")) {
    return { phase: "verifying", percent: 100, detail: "Verifying download…" };
  }
  if (text.startsWith("pulling manifest")) {
    return { phase: "preparing", percent: 0, detail: "Contacting Ollama…" };
  }
  // A failure line is not progress. The child's exit handler turns the whole
  // stderr tail into one explained message, so surfacing this here only flashed
  // a bare `Error: 429:` into the progress line for a frame before that landed.
  if (/^Error\b/i.test(text)) return null;
  const pct = /(\d{1,3})%/.exec(text);
  if (pct) {
    const percent = Math.min(100, Number(pct[1]));
    return {
      phase: "downloading",
      percent,
      detail: formatTransfer(text) ?? `${percent}% downloaded`,
    };
  }
  return { phase: "downloading", detail: text };
}

/**
 * Map a failed pull's stderr to the one action that fixes it. Ollama ≥0.32 has
 * a manifest-realm bug pulling `hf.co/…` and gated/auth-required repos need a
 * token — everything else is passed through with context.
 */
export function explainPullFailure(stderrTail: string): string {
  if (stderrTail.includes("realm host")) {
    return "This Ollama version can't pull from Hugging Face (a 0.32 manifest bug). Upgrade Ollama, then try again.";
  }
  if (/\b401\b|unauthorized|invalid username or password/i.test(stderrTail)) {
    return "Hugging Face rejected the download as unauthenticated. Connect an HF token under the Hugging Face provider (or `ollama login huggingface.co`), then retry.";
  }
  if (/sharded/i.test(stderrTail)) {
    return SHARDED_MESSAGE;
  }
  if (/no such file|not found|404/i.test(stderrTail)) {
    return "Hugging Face has no GGUF file in that repo, or the quant doesn't exist. Pick another model.";
  }
  if (/\b429\b|rate limit/i.test(stderrTail)) {
    return "Hugging Face rate-limited this machine. Wait a few minutes, or connect an HF token under the Hugging Face provider to raise the limit, then retry.";
  }
  // The tail is usually a redrawn TUI frame (progress bars, cursor codes, the
  // next frame glued on) with the real cause appended. Prefer ollama's own
  // `Error:` sentence; fall back to the last few lines for anything else.
  const clean = stderrTail.replace(ANSI_NOISE, " ").replace(/[\u2580-\u259f]/g, "");
  const reported = /\bError:.*/.exec(clean);
  const tail = reported
    ? reported[0].replace(/\s+/g, " ").trim()
    : clean.trim().split("\n").slice(-3).join(" ").replace(/\s+/g, " ").trim();
  return tail ? `Ollama pull failed: ${tail}` : "Ollama pull failed.";
}

/** `12.4M` → `12.4M downloads`, `3,412` stays exact under 1000. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString("en-US");
}
