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
      id: "local-2026-08-26-packaging-and-review-recovery",
      label: "August 26 update",
      date: "2026-08-26",
      items: [
        "GG Coder can now prepare and test installers for supported desktop apps built with Tauri. Run `/setup-tauri-package` once, then `/package-tauri` for repeatable builds with fewer manual steps.",
        "Roadmap final reviews now retry once when a result is missing or out of date. If completion still needs attention, follow the recovery message to retry without losing the failure details.",
      ],
    });
  });

  it.each([
    [
      "3fdc4d572e7fa6746e6c77fe3a61413f31f648aa",
      "GG Coder can now prepare and test installers for supported desktop apps built with Tauri. Run `/setup-tauri-package` once, then `/package-tauri` for repeatable builds with fewer manual steps.",
    ],
    [
      "366a927e2573ace9f0af6ddcbb7fa3d9b36e0a92",
      "Roadmap final reviews now retry once when a result is missing or out of date. If completion still needs attention, follow the recovery message to retry without losing the failure details.",
    ],
  ])("keeps the Local Fork note for commit %s", (_commit, note) => {
    expect(LOCAL_CHANGELOG.flatMap(({ items }) => items)).toContain(note);
  });

  it("keeps shipped Local Fork IDs unique", () => {
    expect(new Set(LOCAL_CHANGELOG.map(({ id }) => id)).size).toBe(LOCAL_CHANGELOG.length);
  });
});
