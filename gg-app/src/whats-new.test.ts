import { beforeEach, describe, expect, it } from "vitest";
import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import {
  LEGACY_WHATS_NEW_STORAGE_KEY,
  WHATS_NEW_STORAGE_KEY,
  availableWhatsNewFeeds,
  getWhatsNewStatus,
  limitWhatsNewEntries,
  markWhatsNewFeedSeen,
  type WhatsNewEntry,
} from "./whats-new";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe("What's New feeds", () => {
  it("seeds every current head silently on first install", () => {
    const status = getWhatsNewStatus(storage, true);

    expect(status.unreadFeedIds).toEqual([]);
    expect(JSON.parse(storage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual({
      local: LOCAL_CHANGELOG[0].id,
      upstream: CHANGELOG[0].version,
    });
  });

  it("migrates the legacy Upstream marker while leaving Local Fork unread", () => {
    storage.setItem(LEGACY_WHATS_NEW_STORAGE_KEY, CHANGELOG[0].version);

    const status = getWhatsNewStatus(storage, true);

    expect(status.unreadFeedIds).toEqual(["local"]);
    expect(JSON.parse(storage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual({
      upstream: CHANGELOG[0].version,
    });
  });

  it("detects Local Fork and Upstream unread heads independently", () => {
    storage.setItem(
      WHATS_NEW_STORAGE_KEY,
      JSON.stringify({ local: LOCAL_CHANGELOG[0].id, upstream: CHANGELOG[1].version }),
    );
    expect(getWhatsNewStatus(storage, true).unreadFeedIds).toEqual(["upstream"]);

    storage.setItem(
      WHATS_NEW_STORAGE_KEY,
      JSON.stringify({ local: LOCAL_CHANGELOG[1].id, upstream: CHANGELOG[0].version }),
    );
    expect(getWhatsNewStatus(storage, true).unreadFeedIds).toEqual(["local"]);
  });

  it("marks only the selected feed seen", () => {
    storage.setItem(
      WHATS_NEW_STORAGE_KEY,
      JSON.stringify({ local: LOCAL_CHANGELOG[1].id, upstream: CHANGELOG[1].version }),
    );

    markWhatsNewFeedSeen(storage, true, "local");

    expect(JSON.parse(storage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual({
      local: LOCAL_CHANGELOG[0].id,
      upstream: CHANGELOG[1].version,
    });
    expect(getWhatsNewStatus(storage, true).unreadFeedIds).toEqual(["upstream"]);
  });

  it("treats a previously retained entry as unread after a new head is prepended", () => {
    storage.setItem(
      WHATS_NEW_STORAGE_KEY,
      JSON.stringify({ local: LOCAL_CHANGELOG[1].id, upstream: CHANGELOG[0].version }),
    );

    expect(getWhatsNewStatus(storage, true).unreadFeedIds).toContain("local");
  });

  it.each([
    ["malformed", "{"],
    ["oversized", "x".repeat(2049)],
    [
      "unknown keys",
      JSON.stringify({
        local: LOCAL_CHANGELOG[0].id,
        upstream: CHANGELOG[0].version,
        surprise: "open-me",
      }),
    ],
  ])("replaces %s storage without creating surprise unread notes", (_name, raw) => {
    storage.setItem(WHATS_NEW_STORAGE_KEY, raw);

    const status = getWhatsNewStatus(storage, true);

    expect(status.unreadFeedIds).toEqual([]);
    expect(JSON.parse(storage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual({
      local: LOCAL_CHANGELOG[0].id,
      upstream: CHANGELOG[0].version,
    });
  });

  it("filters Local Fork from official builds", () => {
    const status = getWhatsNewStatus(storage, false);

    expect(status.feeds.map(({ id }) => id)).toEqual(["upstream"]);
    expect(availableWhatsNewFeeds(false)[0].label).toBe("Upstream");
  });

  it("caps each feed at 50 bullets while preserving entry groups", () => {
    const entries: WhatsNewEntry[] = [
      { id: "new", label: "New", date: "2026-08-23", items: Array(30).fill("new") },
      { id: "old", label: "Old", date: "2026-08-22", items: Array(30).fill("old") },
    ];

    const limited = limitWhatsNewEntries(entries);

    expect(limited.map(({ id }) => id)).toEqual(["new", "old"]);
    expect(limited[0].items).toHaveLength(30);
    expect(limited[1].items).toHaveLength(20);
  });

  it("keeps the latest Local Fork release notes complete", () => {
    expect(LOCAL_CHANGELOG[0]).toEqual({
      id: "local-2026-08-25-ui-and-update-reliability",
      label: "Local Fork",
      date: "2026-08-25",
      items: [
        "Added optional verified update summaries and a Decisions tab in What’s New.",
        "Prompt submission failures now appear in the conversation instead of failing silently.",
        "Roadmap cards now expand in place, run primary actions directly, and preserve verification evidence.",
        "Roadmap completion now requires the expected final review and successful fresh verification.",
        "Local Fork updates now verify the installer, close gracefully, install automatically, and relaunch your existing profile.",
        "Sidecar builds now promote atomically and preserve the previous working bundle after validation failures.",
        "Local Fork builds no longer show the automatic-update footer banner.",
      ],
    });
  });

  it("keeps shipped Local Fork IDs unique", () => {
    expect(new Set(LOCAL_CHANGELOG.map(({ id }) => id)).size).toBe(LOCAL_CHANGELOG.length);
  });
});
