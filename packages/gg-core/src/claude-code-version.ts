import fs from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "./paths.js";
import { log } from "./logger.js";

// Anthropic's OAuth edge rejects requests whose claude-cli UA version lags too
// far behind the actual Claude Code release. Resolve dynamically from the npm
// registry so we never ship a stale-version time bomb.
const NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
// Last known good version at publish time. Used only when the npm fetch fails
// and no on-disk cache exists (e.g. first run on an offline machine). Keep
// reasonably current — bump on each ggcoder release.
const FALLBACK_VERSION = "2.1.280";

// Anthropic gates brand-new models on a minimum client version and says so in
// the 400 body, e.g. "Claude Code 2.1.278 does not support this model; version
// 2.1.280 or newer is required." Our 24h cache can otherwise pin a too-old
// version for a whole day after such a release.
const REQUIRED_VERSION_RE = /version\s+(\d+(?:\.\d+)+)\s+or\s+newer\s+is\s+required/i;

type CachedVersion = { version: string; fetchedAt: number };

/** Numeric-segment comparison. Returns >0 when `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Extract the minimum client version Anthropic demands, if the error says so. */
export function parseRequiredClaudeCodeVersion(message: string): string | null {
  return REQUIRED_VERSION_RE.exec(message)?.[1] ?? null;
}

let memoryCache: { version: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

function cachePath(): string {
  return path.join(getAppPaths().agentDir, "claude-code-version.json");
}

async function readDiskCache(): Promise<CachedVersion | null> {
  try {
    const raw = await fs.readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CachedVersion;
    if (typeof parsed.version === "string" && typeof parsed.fetchedAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeDiskCache(data: CachedVersion): Promise<void> {
  try {
    await fs.mkdir(getAppPaths().agentDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(cachePath(), JSON.stringify(data), { mode: 0o600 });
  } catch (err) {
    log(
      "WARN",
      "claude-code-version",
      `Failed to write cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(NPM_LATEST_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    if (typeof data.version === "string" && /^\d/.test(data.version)) {
      return data.version;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the current Claude Code release version for spoofing the claude-cli
 * User-Agent on OAuth and inference requests. Cached in-memory for the process
 * lifetime and on disk for 24h. Falls back to a hardcoded constant if the npm
 * registry is unreachable and no cache exists.
 */
export async function getClaudeCodeVersion(): Promise<string> {
  if (memoryCache && Date.now() < memoryCache.expiresAt) {
    return memoryCache.version;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const disk = await readDiskCache();
    const diskFresh = disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS;
    if (disk && diskFresh) {
      memoryCache = { version: disk.version, expiresAt: Date.now() + CACHE_TTL_MS };
      return disk.version;
    }
    const fetched = await fetchLatest();
    if (fetched) {
      await writeDiskCache({ version: fetched, fetchedAt: Date.now() });
      memoryCache = { version: fetched, expiresAt: Date.now() + CACHE_TTL_MS };
      return fetched;
    }
    // npm unreachable — prefer stale disk cache over hardcoded fallback.
    const resolved = disk?.version ?? FALLBACK_VERSION;
    // Short TTL so we retry the npm fetch soon, but don't hammer it.
    memoryCache = { version: resolved, expiresAt: Date.now() + 5 * 60 * 1000 };
    log(
      "WARN",
      "claude-code-version",
      `Failed to fetch latest Claude Code version; using ${resolved}`,
    );
    return resolved;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Adopt a minimum client version demanded by an Anthropic error, bypassing the
 * 24h cache. Returns true when the floor was raised, meaning the caller should
 * rebuild the User-Agent and retry.
 */
export async function noteRequiredClaudeCodeVersion(message: string): Promise<boolean> {
  const required = parseRequiredClaudeCodeVersion(message);
  if (!required) return false;

  // Prefer whatever npm currently says (it may already be past `required`);
  // fall back to the demanded version itself when the registry is unreachable.
  const latest = await fetchLatest();
  const target = latest && compareVersions(latest, required) > 0 ? latest : required;

  const current = memoryCache?.version ?? (await readDiskCache())?.version;
  if (current && compareVersions(target, current) <= 0) return false;

  await writeDiskCache({ version: target, fetchedAt: Date.now() });
  memoryCache = { version: target, expiresAt: Date.now() + CACHE_TTL_MS };
  log("INFO", "claude-code-version", `Anthropic requires >= ${required}; adopting ${target}`);
  return true;
}

/** Build the User-Agent string Anthropic's OAuth + inference edges expect. */
export async function getClaudeCliUserAgent(): Promise<string> {
  const version = await getClaudeCodeVersion();
  return `claude-cli/${version} (external, cli)`;
}
