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

/** Map a Hub `/api/models?search=` result entry to what the dropdown shows. */
export function toHfSearchRow(entry: {
  id?: unknown;
  downloads?: unknown;
  likes?: unknown;
  lastModified?: unknown;
}): HfSearchRow | null {
  if (typeof entry.id !== "string" || !isValidHfRepoId(entry.id)) return null;
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
 * Pick which GGUF file `ollama pull` should fetch. Deterministic: the first
 * entry of `QUANT_PREFERENCE` present, else the smallest file (multi-quant
 * repos list big quants first), else the only file — tagless when the repo
 * ships a single unnamed GGUF.
 */
export function pickGgufQuant(files: readonly GgufFile[]): QuantChoice | null {
  const ggufs = files.filter((f) => f.path.toLowerCase().endsWith(".gguf"));
  if (ggufs.length === 0) return null;
  for (const quant of QUANT_PREFERENCE) {
    const hit = ggufs.find((f) => quantFromFilename(f.path) === quant);
    if (hit) return { tag: quant, file: hit };
  }
  const smallest = ggufs.reduce((a, b) => (a.sizeBytes <= b.sizeBytes ? a : b));
  return { tag: quantFromFilename(smallest.path), file: smallest };
}

export type PullPhase = "preparing" | "downloading" | "verifying" | "success" | "error";

export interface PullProgress {
  phase: PullPhase;
  /** 0-100 while downloading; sticky afterwards. */
  percent?: number;
  /** Raw human text, e.g. `45% 1.2 GB/2.7 GB 30 MB/s`. */
  detail?: string;
}

/** Strip terminal control noise (cursor moves, enable/disable, spinner
 *  frames) that ollama emits even when piped, so lines stay readable. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const ANSI_NOISE = /\u001b\[[0-9;?]*[A-Za-z]|[\u001b\u0000-\u0008\u000b-\u001f]|[\u2800-\u28ff]/g;

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
    return { phase: "verifying", percent: 100, detail: text };
  }
  if (text.startsWith("pulling manifest")) {
    return { phase: "preparing", percent: 0, detail: text };
  }
  const pct = /(\d{1,3})%/.exec(text);
  if (pct) {
    const percent = Math.min(100, Number(pct[1]));
    return {
      phase: "downloading",
      percent,
      detail: text.replace(/^(pulling\s+)?[a-f0-9]{6,64}:\s*/, ""),
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
  if (/no such file|not found|404/i.test(stderrTail)) {
    return "Hugging Face has no GGUF file in that repo, or the quant doesn't exist. Pick another model.";
  }
  const tail = stderrTail.trim().split("\n").slice(-3).join(" ");
  return tail ? `Ollama pull failed: ${tail}` : "Ollama pull failed.";
}

/** `12.4M` → `12.4M downloads`, `3,412` stays exact under 1000. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString("en-US");
}
