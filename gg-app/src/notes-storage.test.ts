import { describe, expect, it } from "vitest";
import type { NotesDocumentV2 } from "./notes-types";
import {
  canonicalProjectKey,
  createNotesRepository,
  legacyNotesKey,
  parseNotesDocument,
  v2NotesKey,
} from "./notes-storage";

const NOW = "2026-07-15T12:00:00.000Z";

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
    if (this.failingWrites.has(key)) throw new DOMException("Storage full", "QuotaExceededError");
    this.values.set(key, value);
  }
}

function document(reference: string): NotesDocumentV2 {
  return {
    version: 2,
    reference,
    currentFocus: "Ship structured notes",
    tasks: [
      {
        id: "task-1",
        text: "Verify switching",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
    ],
    handoff: { text: "Continue here", updatedAt: NOW, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
  };
}

describe("structured project notes storage", () => {
  it("imports legacy free-form notes byte-for-byte into the project-scoped v2 document", () => {
    const cwd = "C:\\Work\\Project";
    const storage = new MemoryStorage();
    const legacy = "  existing\r\nnotes 😀\n";
    storage.setItem(legacyNotesKey(cwd), legacy);

    const loaded = createNotesRepository(storage, () => NOW).load(cwd);
    const persisted = parseNotesDocument(storage.getItem(v2NotesKey(cwd))!);

    expect(loaded.document.reference).toBe(legacy);
    expect(loaded.document.legacyImportedAt).toBe(NOW);
    expect(persisted.ok && persisted.document.reference).toBe(legacy);
    expect(storage.getItem(legacyNotesKey(cwd))).toBe(legacy);
  });

  it("round-trips structured fields while keeping the rollback reference key", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const notes = document("reference bytes");
    const repository = createNotesRepository(storage, () => NOW);

    repository.save(cwd, notes);

    expect(repository.load(cwd).document).toEqual(notes);
    expect(storage.getItem(legacyNotesKey(cwd))).toBe("reference bytes");
  });

  it("keeps a newer v2 reference when the rollback legacy write fails", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const repository = createNotesRepository(storage, () => NOW);
    storage.setItem(legacyNotesKey(cwd), "old reference");
    storage.failingWrites.add(legacyNotesKey(cwd));

    const saved = repository.save(cwd, document("new reference"));
    const loaded = repository.load(cwd);

    expect(saved.legacy.ok).toBe(false);
    expect(saved.v2.ok).toBe(true);
    expect(loaded.document.reference).toBe("new reference");
    expect(storage.getItem(legacyNotesKey(cwd))).toBe("old reference");
  });

  it("converges Windows cwd aliases but preserves POSIX case", () => {
    expect(v2NotesKey("C:\\Work\\.\\App\\..\\Project\\")).toBe(v2NotesKey("c:/work/project"));
    expect(canonicalProjectKey("/Work/Project")).not.toBe(canonicalProjectKey("/work/project"));
  });
});
