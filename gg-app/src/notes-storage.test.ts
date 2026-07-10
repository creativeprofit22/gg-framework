import { describe, expect, it } from "vitest";
import type { NotesDocumentV2 } from "./notes-types";
import {
  canonicalProjectKey,
  createEmptyNotesDocument,
  createNotesRepository,
  legacyNotesKey,
  parseNotesDocument,
  v2NotesKey,
} from "./notes-storage";

const NOW = "2026-07-09T12:00:00.000Z";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly failingWrites = new Set<string>();

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
    if (this.failingWrites.has(key))
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    this.values.set(key, value);
  }
}

function repository(storage: Storage) {
  return createNotesRepository(storage, () => NOW);
}

function structuredDocument(): NotesDocumentV2 {
  return {
    version: 2,
    reference: "reference\r\n😀\n",
    currentFocus: "Ship Phase 1",
    tasks: [
      {
        id: "second",
        text: "Completed but archived",
        status: "done",
        createdAt: "2026-07-01T01:02:03.000Z",
        updatedAt: "2026-07-02T01:02:03.000Z",
        completedAt: "2026-07-02T01:02:03.000Z",
        archivedAt: "2026-07-03T01:02:03.000Z",
      },
      {
        id: "first",
        text: "Still todo",
        status: "todo",
        createdAt: "2026-07-04T01:02:03.000Z",
        updatedAt: "2026-07-05T01:02:03.000Z",
        completedAt: null,
        archivedAt: null,
      },
    ],
    handoff: {
      text: "Continue here",
      updatedAt: "2026-07-06T01:02:03.000Z",
      readAt: "2026-07-07T01:02:03.000Z",
    },
    updatedAt: "2026-07-08T01:02:03.000Z",
    legacyImportedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("notes storage", () => {
  it("creates and persists a valid empty v2 document", () => {
    const storage = new MemoryStorage();
    const result = repository(storage).load("/work/project/");

    expect(result.source).toBe("empty");
    expect(result.document).toEqual(createEmptyNotesDocument(NOW));
    expect(parseNotesDocument(storage.getItem(v2NotesKey("/work/project"))!)).toEqual({
      ok: true,
      document: result.document,
    });
    expect(storage.getItem(legacyNotesKey("/work/project/"))).toBeNull();
  });

  it.each(["", "   ", "first\r\nsecond", "Notes 😀 日本語", "line\n\n"])(
    "imports legacy bytes exactly: %j",
    (legacy) => {
      const cwd = "C:\\Work\\Project\\";
      const storage = new MemoryStorage();
      storage.setItem(legacyNotesKey(cwd), legacy);

      const result = repository(storage).load(cwd);
      const persisted = parseNotesDocument(storage.getItem(v2NotesKey(cwd))!);

      expect(result.value).toBe(legacy);
      expect(result.document.reference).toBe(legacy);
      expect(result.document.legacyImportedAt).toBe(NOW);
      expect(result.v2ImportSucceeded).toBe(true);
      expect(persisted.ok && persisted.document.reference).toBe(legacy);
      expect(storage.getItem(legacyNotesKey(cwd))).toBe(legacy);
    },
  );

  it("round-trips all structured fields, task order, completion, and archive metadata", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const document = structuredDocument();

    const saved = repository(storage).save(cwd, document);
    const loaded = repository(storage).load(cwd);

    expect(saved.legacy.ok).toBe(true);
    expect(saved.v2.ok).toBe(true);
    expect(loaded.document).toEqual(document);
    expect(loaded.document.tasks.map((task) => task.id)).toEqual(["second", "first"]);
  });

  it("uses legacy reference while preserving every structured v2 field", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const document = structuredDocument();
    storage.setItem(v2NotesKey(cwd), JSON.stringify(document));
    storage.setItem(legacyNotesKey(cwd), "newer legacy bytes\n");

    const result = repository(storage).load(cwd);

    expect(result.document).toEqual({ ...document, reference: "newer legacy bytes\n" });
    expect(storage.getItem(v2NotesKey(cwd))).toBe(JSON.stringify(document));
  });

  it.each([
    ["malformed JSON", "{"],
    ["missing fields", JSON.stringify({ version: 2, reference: "legacy" })],
    [
      "wrong field types",
      JSON.stringify({
        ...structuredDocument(),
        tasks: [{ ...structuredDocument().tasks[0], id: 7 }],
      }),
    ],
    ["unknown version", JSON.stringify({ ...structuredDocument(), version: 999 })],
  ])("falls back to legacy without rewriting %s", (_label, badV2) => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    storage.setItem(v2NotesKey(cwd), badV2);
    storage.setItem(legacyNotesKey(cwd), "authoritative legacy");
    const before = new Map(storage.values);

    const result = repository(storage).load(cwd);

    expect(result.source).toBe("legacy-fallback");
    expect(result.value).toBe("authoritative legacy");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "v2-parse" }));
    expect(storage.values).toEqual(before);
  });

  it("does not rewrite a malformed v2 record when legacy is absent", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    storage.setItem(v2NotesKey(cwd), "not json");

    const result = repository(storage).load(cwd);

    expect(result.value).toBe("");
    expect(storage.getItem(v2NotesKey(cwd))).toBe("not json");
    expect(storage.getItem(legacyNotesKey(cwd))).toBeNull();
  });

  it("restores the exact legacy value from a valid v2-only record", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const document = structuredDocument();
    storage.setItem(v2NotesKey(cwd), JSON.stringify(document));

    const result = repository(storage).load(cwd);

    expect(result.legacyRecoveryAttempted).toBe(true);
    expect(result.legacyRecoverySucceeded).toBe(true);
    expect(storage.getItem(legacyNotesKey(cwd))).toBe(document.reference);
  });

  it("reports legacy-first and v2 write failures independently without throwing", () => {
    const cwd = "/work/project";
    const document = structuredDocument();

    const v2Failure = new MemoryStorage();
    v2Failure.failingWrites.add(v2NotesKey(cwd));
    const first = repository(v2Failure).save(cwd, document);
    expect(first.legacy.ok).toBe(true);
    expect(first.v2.ok).toBe(false);
    expect(v2Failure.getItem(legacyNotesKey(cwd))).toBe(document.reference);

    const legacyFailure = new MemoryStorage();
    legacyFailure.failingWrites.add(legacyNotesKey(cwd));
    const second = repository(legacyFailure).save(cwd, document);
    expect(second.legacy.ok).toBe(false);
    expect(second.v2.ok).toBe(true);
  });

  it("prefers the exact legacy key over canonical aliases", () => {
    const storage = new MemoryStorage();
    const cwd = "C:\\Work\\Project";
    storage.setItem(legacyNotesKey(cwd), "exact");
    storage.setItem("gg-notes:c:/work/project/", "alias");

    const result = repository(storage).load(cwd);

    expect(result.value).toBe("exact");
    expect(result.legacyKey).toBe(legacyNotesKey(cwd));
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ kind: "ambiguous-legacy" }),
    );
  });

  it("converges Windows drive and UNC variants while preserving POSIX case", () => {
    expect(canonicalProjectKey("C:\\Work\\.\\App\\..\\Project\\")).toBe("c:/work/project");
    expect(canonicalProjectKey("c:/work/project")).toBe("c:/work/project");
    expect(canonicalProjectKey("\\\\Server\\Share\\Folder\\..\\Project\\")).toBe(
      "//server/share/project",
    );
    expect(canonicalProjectKey("//SERVER/share/project")).toBe("//server/share/project");
    expect(canonicalProjectKey("/Work/Project")).not.toBe(canonicalProjectKey("/work/project"));
  });

  it("selects ambiguous aliases lexicographically and reports every match", () => {
    const storage = new MemoryStorage();
    storage.setItem("gg-notes:c:/WORK/project/", "z-selected-by-key");
    storage.setItem("gg-notes:C:\\Work\\Project", "a-selected-by-key");

    const result = repository(storage).load("c:/work/project");
    const expectedKeys = ["gg-notes:C:\\Work\\Project", "gg-notes:c:/WORK/project/"].sort();

    expect(result.legacyKey).toBe(expectedKeys[0]);
    expect(result.value).toBe(storage.getItem(expectedKeys[0]));
    expect(result.diagnostics).toContainEqual({
      kind: "ambiguous-legacy",
      selectedKey: expectedKeys[0],
      matchingKeys: expectedKeys,
    });
  });
});
