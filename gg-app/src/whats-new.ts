import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";

export type WhatsNewFeedId = "local" | "upstream";

export interface WhatsNewEntry {
  id: string;
  label: string;
  date: string;
  items: string[];
}

export interface WhatsNewFeed {
  id: WhatsNewFeedId;
  label: string;
  entries: WhatsNewEntry[];
}

type SeenHeads = Partial<Record<WhatsNewFeedId, string>>;

export interface WhatsNewStatus {
  feeds: WhatsNewFeed[];
  seenHeads: SeenHeads;
  unreadFeedIds: WhatsNewFeedId[];
}

export const WHATS_NEW_STORAGE_KEY = "gg-app:whatsNewHeads:v1";
export const LEGACY_WHATS_NEW_STORAGE_KEY = "gg-app:whatsNewVersion";
const MAX_STORAGE_LENGTH = 2048;
const MAX_HEAD_ID_LENGTH = 200;

const upstreamEntries: WhatsNewEntry[] = CHANGELOG.map(({ version, date, items }) => ({
  id: version,
  label: `v${version}`,
  date,
  items,
}));

const localEntries: WhatsNewEntry[] = LOCAL_CHANGELOG.map(({ id, label, date, items }) => ({
  id,
  label,
  date,
  items,
}));

export function limitWhatsNewEntries(entries: WhatsNewEntry[], maxItems = 50): WhatsNewEntry[] {
  const limited: WhatsNewEntry[] = [];
  let count = 0;
  for (const entry of entries) {
    if (count >= maxItems) break;
    const items = entry.items.slice(0, maxItems - count);
    if (items.length === 0) continue;
    limited.push({ ...entry, items });
    count += items.length;
  }
  return limited;
}

export function availableWhatsNewFeeds(localPatched: boolean): WhatsNewFeed[] {
  const upstream: WhatsNewFeed = {
    id: "upstream",
    label: "Upstream",
    entries: limitWhatsNewEntries(upstreamEntries),
  };
  if (!localPatched) return [upstream];
  return [
    { id: "local", label: "Local Fork", entries: limitWhatsNewEntries(localEntries) },
    upstream,
  ];
}

function currentHeads(feeds: WhatsNewFeed[]): SeenHeads {
  return Object.fromEntries(
    feeds.flatMap((feed) => (feed.entries[0] ? [[feed.id, feed.entries[0].id]] : [])),
  );
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
  const feeds = availableWhatsNewFeeds(localPatched);
  const heads = currentHeads(feeds);
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

  const unreadFeedIds = feeds.flatMap((feed) => {
    const head = feed.entries[0]?.id;
    return head && seenHeads[feed.id] !== head ? [feed.id] : [];
  });
  return { feeds, seenHeads, unreadFeedIds };
}

export function markWhatsNewFeedSeen(
  storage: Storage,
  localPatched: boolean,
  feedId: WhatsNewFeedId,
): void {
  const status = getWhatsNewStatus(storage, localPatched);
  const feed = status.feeds.find(({ id }) => id === feedId);
  const head = feed?.entries[0]?.id;
  if (!head) return;
  writeSeenHeads(storage, { ...status.seenHeads, [feedId]: head });
}
