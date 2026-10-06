export type WhatsNewFeedId = "local" | "upstream";
type SeenHeads = Partial<Record<WhatsNewFeedId, string>>;

// Injected from the actual histories by build/test configuration, never duplicated IDs.
declare const __WHATS_NEW_HEADS__: SeenHeads;

export interface WhatsNewFeedHead {
  id: WhatsNewFeedId;
  label: string;
  head?: string;
}

export interface WhatsNewStatus {
  feeds: WhatsNewFeedHead[];
  seenHeads: SeenHeads;
  unreadFeedIds: WhatsNewFeedId[];
}

export const WHATS_NEW_STORAGE_KEY = "gg-app:whatsNewHeads:v1";
export const LEGACY_WHATS_NEW_STORAGE_KEY = "gg-app:whatsNewVersion";
const MAX_STORAGE_LENGTH = 2048;
const MAX_HEAD_ID_LENGTH = 200;

export function availableWhatsNewHeads(localPatched: boolean): WhatsNewFeedHead[] {
  const upstream: WhatsNewFeedHead = {
    id: "upstream",
    label: "Upstream",
    head: __WHATS_NEW_HEADS__.upstream,
  };
  return localPatched
    ? [{ id: "local", label: "Local Fork", head: __WHATS_NEW_HEADS__.local }, upstream]
    : [upstream];
}

function isHeadId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_HEAD_ID_LENGTH;
}

function parseSeenHeads(raw: string): SeenHeads | null {
  if (raw.length > MAX_STORAGE_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const seen: SeenHeads = {};
    for (const id of ["local", "upstream"] as const) {
      if (record[id] !== undefined) {
        if (!isHeadId(record[id])) return null;
        seen[id] = record[id];
      }
    }
    return seen;
  } catch {
    return null;
  }
}

function writeSeenHeads(storage: Storage, seen: SeenHeads): void {
  try {
    storage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Storage can be unavailable; staying quiet avoids a surprise open loop.
  }
}

export function getWhatsNewStatus(storage: Storage, localPatched: boolean): WhatsNewStatus {
  const feeds = availableWhatsNewHeads(localPatched);
  const heads: SeenHeads = Object.fromEntries(
    feeds.flatMap(({ id, head }) => (head ? [[id, head]] : [])),
  );
  let raw: string | null;
  try {
    raw = storage.getItem(WHATS_NEW_STORAGE_KEY);
  } catch {
    return { feeds, seenHeads: heads, unreadFeedIds: [] };
  }

  let seenHeads: SeenHeads;
  if (raw !== null) {
    const parsed = parseSeenHeads(raw);
    seenHeads = parsed ?? heads;
    if (parsed === null || JSON.stringify(parsed) !== raw) writeSeenHeads(storage, seenHeads);
  } else {
    let legacy: string | null;
    try {
      legacy = storage.getItem(LEGACY_WHATS_NEW_STORAGE_KEY);
    } catch {
      legacy = null;
    }
    seenHeads = legacy !== null && isHeadId(legacy) ? { upstream: legacy } : heads;
    writeSeenHeads(storage, seenHeads);
  }

  const unreadFeedIds = feeds.flatMap(({ id, head }) =>
    head && seenHeads[id] !== head ? [id] : [],
  );
  return { feeds, seenHeads, unreadFeedIds };
}

export function markWhatsNewFeedSeen(
  storage: Storage,
  localPatched: boolean,
  feedId: WhatsNewFeedId,
): void {
  const status = getWhatsNewStatus(storage, localPatched);
  const head = status.feeds.find(({ id }) => id === feedId)?.head;
  if (!head) return;
  writeSeenHeads(storage, { ...status.seenHeads, [feedId]: head });
}
