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
  failReads = false;
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException("Storage blocked", "SecurityError");
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

  it("marks only safe browser states as eligible for sidecar migration", () => {
    const cwd = "/work/project";

    const empty = createNotesRepository(new MemoryStorage(), () => NOW).load(cwd);

    const validV2Storage = new MemoryStorage();
    validV2Storage.setItem(v2NotesKey(cwd), JSON.stringify(document("v2")));
    const validV2 = createNotesRepository(validV2Storage, () => NOW).load(cwd);

    const legacyStorage = new MemoryStorage();
    legacyStorage.setItem(v2NotesKey(cwd), "{broken");
    legacyStorage.setItem(legacyNotesKey(cwd), "  legacy\r\nbytes ");
    const legacyFallback = createNotesRepository(legacyStorage, () => NOW).load(cwd);

    expect(empty.migrationEligibility).toBe("empty");
    expect(validV2.migrationEligibility).toBe("valid-v2");
    expect(legacyFallback.migrationEligibility).toBe("valid-legacy");
    expect(legacyFallback.document.reference).toBe("  legacy\r\nbytes ");
  });

  it("refuses sidecar initialization from malformed or unsupported v2-only records", () => {
    const cwd = "/work/project";
    for (const raw of ["{broken", JSON.stringify({ ...document("future"), version: 3 })]) {
      const storage = new MemoryStorage();
      storage.setItem(v2NotesKey(cwd), raw);

      const loaded = createNotesRepository(storage, () => NOW).load(cwd);

      expect(loaded.migrationEligibility).toBe("ineligible-invalid-v2");
      expect(storage.getItem(v2NotesKey(cwd))).toBe(raw);
    }
  });

  it.each([
    ["document", { ...document("extra document field"), extra: true }],
    [
      "task",
      {
        ...document("extra task field"),
        tasks: [{ ...document("extra task field").tasks[0], extra: true }],
      },
    ],
    [
      "handoff",
      {
        ...document("extra handoff field"),
        handoff: { ...document("extra handoff field").handoff, extra: true },
      },
    ],
  ])("preserves and refuses migration for v2 records with an extra %s key", (_level, value) => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const raw = JSON.stringify(value);
    storage.setItem(v2NotesKey(cwd), raw);

    const parsed = parseNotesDocument(raw);
    const loaded = createNotesRepository(storage, () => NOW).load(cwd);

    expect(parsed).toEqual({ ok: false, reason: "invalid-shape" });
    expect(loaded.migrationEligibility).toBe("ineligible-invalid-v2");
    expect(loaded.diagnostics).toContainEqual({ kind: "v2-parse", reason: "invalid-shape" });
    expect(storage.getItem(v2NotesKey(cwd))).toBe(raw);
  });

  it("refuses sidecar initialization when browser storage cannot be read", () => {
    const storage = new MemoryStorage();
    storage.failReads = true;

    const loaded = createNotesRepository(storage, () => NOW).load("/work/project");

    expect(loaded.migrationEligibility).toBe("ineligible-unreadable");
    expect(loaded.diagnostics.some((diagnostic) => diagnostic.kind === "storage-read")).toBe(true);
  });

  it("converges Windows cwd aliases but preserves POSIX case", () => {
    expect(v2NotesKey("C:\\Work\\.\\App\\..\\Project\\")).toBe(v2NotesKey("c:/work/project"));
    expect(canonicalProjectKey("/Work/Project")).not.toBe(canonicalProjectKey("/work/project"));
  });
});
