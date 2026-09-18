import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import localReleaseNotes from "./local-release-notes.json";
import {
  LEGACY_WHATS_NEW_STORAGE_KEY,
  WHATS_NEW_STORAGE_KEY,
  availableWhatsNewHeads,
  getWhatsNewStatus,
  markWhatsNewFeedSeen,
} from "./whats-new-status";
import { availableWhatsNewFeeds, limitWhatsNewEntries, type WhatsNewEntry } from "./whats-new";

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
  it("derives lightweight heads from the exact displayed history heads", () => {
    for (const localPatched of [true, false]) {
      expect(availableWhatsNewHeads(localPatched)).toEqual(
        availableWhatsNewFeeds(localPatched).map(({ id, label, entries }) => ({
          id,
          label,
          head: entries[0]?.id,
        })),
      );
    }
  });
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

  it("keeps the latest Local Fork release notes identical to the source contract", () => {
    expect(LOCAL_CHANGELOG[0]).toEqual({
      id: "local-2026-09-18-upstream-0651-queues-and-discovery",
      label: localReleaseNotes.label,
      date: localReleaseNotes.date,
      items: localReleaseNotes.sections.flatMap(({ items }) => items),
    });
  });

  it("preserves the prior shipped Local Fork identities and dates", () => {
    expect(LOCAL_CHANGELOG[1].id).toBe("local-2026-09-15-upstream-0650-reviewed-commands");
    expect(LOCAL_CHANGELOG[1].date).toBe("2026-09-15");
    expect(createHash("sha256").update(JSON.stringify(LOCAL_CHANGELOG[1])).digest("hex")).toBe(
      "a953bb81124c0be2a98786440c2ca3aedf241ae9bdf56d0f9455c54d3f8b3a0a",
    );
    expect(LOCAL_CHANGELOG[2]).toEqual({
      id: "local-2026-09-12-upstream-0634-reviews-and-replies",
      label: "Upstream 0.63.4, with reviews that stay in reach",
      date: "2026-09-12",
      items: [
        "Review without losing your conversation. `Pending reviews` keeps plan approvals and proposed `Roadmap` phases inside the pane, with room to read and scroll while your chat and draft stay in place. A missed notification can recover the same pending proposal while its session is still running; it does not create a second proposal or approve it for you.",
        "Finished an existing `Roadmap` phase? You can now ask the coding agent to record `Done` from your completion report, checking the phase's own goal and completion criteria rather than unrelated release gates. Supporting evidence is still required, and newly proposed phases still wait for your approval.",
        "Get an answer shaped around your question, not a fixed checklist. Replies now favor readable paragraphs and an actionable opening, with room for the detail your task needs instead of a rigid line limit or mandatory status label.",
        "Keep your intent when you use `Enhance?`. The rewrite instructions now make your questions, exclusions, and restart boundaries explicit, so polishing a request is not permission to add work or turn a question into an implementation task.",
        "Let your build finish. Foreground commands now run without a time limit unless one is explicitly requested, including commands that reuse a shell. A hidden five-minute cutoff no longer overrides that choice. You can still stop the work yourself.",
        "Long conversations keep a clearer trail of unfinished fixes. Failing test names now stay in the agent's compacted memory until matching passing results clear them, so shortening the conversation does not silently drop the failures it still needs to address.",
        "Replace repeated text without duplicating the replacement. Global `replace_all` edits now handle each match once, including replacements that contain the original text, rather than accidentally editing their own output.",
        "Read the conversation, not raw diagnostic dumps. Post-edit checks still send problems to the agent, but their internal output stays out of your chat. Your Local Fork also keeps automatic check reminders removed without calling failed or unfinished commands passed.",
        "Know an image limit before chasing another retry. `Flare` and `Sunburst` explain that `transparent backgrounds` are unavailable through your ChatGPT connection, rather than switching models or silently substituting an opaque image.",
      ],
    });
    expect(LOCAL_CHANGELOG[3].id).toBe("local-2026-09-09-upstream-0630-images-and-prompts");
    expect(LOCAL_CHANGELOG[3].label).toBe(
      "Upstream 0.63.0, with clearer prompts and image results",
    );
    expect(LOCAL_CHANGELOG[3].date).toBe("2026-09-09");
    expect(LOCAL_CHANGELOG[3].items).toHaveLength(8);
    expect(LOCAL_CHANGELOG[4].id).toBe("local-2026-09-07-upstream-0621-and-roadmap-recovery");
    expect(LOCAL_CHANGELOG[4].label).toBe("Upstream 0.62.1, with steadier Roadmap updates");
    expect(LOCAL_CHANGELOG[4].date).toBe("2026-09-07");
    expect(LOCAL_CHANGELOG[4].items).toHaveLength(5);
    expect(LOCAL_CHANGELOG[5].id).toBe("local-2026-08-29-roadmap-completion-fails-closed");
    expect(LOCAL_CHANGELOG[5].label).toBe("Upstream 0.62.0, still your Local Fork");
    expect(LOCAL_CHANGELOG[5].date).toBe("2026-09-06");
    expect(LOCAL_CHANGELOG[5].items).toHaveLength(14);
  });

  it.each([
    [
      "3fdc4d572e7fa6746e6c77fe3a61413f31f648aa",
      "Less installer busywork. Set up packaging once for a supported desktop app, then let GG Coder prepare and check repeat builds for you.",
    ],
    [
      "366a927e2573ace9f0af6ddcbb7fa3d9b36e0a92",
      "A missing review shouldn’t leave you stuck. `Roadmap` now retries a missing or outdated final review once. Still blocked? The recovery message keeps the details and points you to the next step.",
    ],
  ])("keeps the Local Fork note for commit %s", (_commit, note) => {
    expect(LOCAL_CHANGELOG.flatMap(({ items }) => items)).toContain(note);
  });

  it("keeps shipped Local Fork IDs unique", () => {
    expect(new Set(LOCAL_CHANGELOG.map(({ id }) => id)).size).toBe(LOCAL_CHANGELOG.length);
  });
});
