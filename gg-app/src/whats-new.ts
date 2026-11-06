import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import { availableWhatsNewHeads, type WhatsNewFeedId } from "./whats-new-status";

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
  return availableWhatsNewHeads(localPatched).map(({ id, label }) => ({
    id,
    label,
    entries: limitWhatsNewEntries(id === "local" ? localEntries : upstreamEntries),
  }));
}
