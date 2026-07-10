// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createNotesRepository, legacyNotesKey, v2NotesKey } from "./notes-storage";
import { useProjectNotes } from "./useProjectNotes";

const NOW = "2026-07-09T12:00:00.000Z";
const LATER = "2026-07-09T12:01:00.000Z";
const fixedClock = (): string => NOW;

class ObservableStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly failingWrites = new Set<string>();
  writeCount = 0;

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
    this.writeCount += 1;
    if (this.failingWrites.has(key)) throw new DOMException("Full", "QuotaExceededError");
    this.values.set(key, value);
  }
}

class FakeStorageEvents {
  readonly listeners = new Set<(event: StorageEvent) => void>();

  addEventListener(_type: "storage", listener: (event: StorageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "storage", listener: (event: StorageEvent) => void): void {
    this.listeners.delete(listener);
  }

  dispatch(key: string, newValue: string | null = null): void {
    const event = new StorageEvent("storage", { key, newValue });
    for (const listener of [...this.listeners]) listener(event);
  }
}

function options(storage: ObservableStorage, events = new FakeStorageEvents()) {
  return {
    storage,
    repository: createNotesRepository(storage, fixedClock),
    eventTarget: events,
    clock: fixedClock,
  };
}

describe("useProjectNotes", () => {
  it("loads existing legacy text byte-for-byte as its initial value", () => {
    const cwd = "C:\\Work\\Project";
    const storage = new ObservableStorage();
    const legacy = "  first\r\nsecond 😀\n\n";
    storage.setItem(legacyNotesKey(cwd), legacy);
    const hookOptions = options(storage);

    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));

    expect(result.current.value).toBe(legacy);
  });

  it("updates React state and both keys synchronously on edit", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    const hookOptions = options(storage);
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));

    act(() => result.current.onChange("edited\r\n😀\n"));

    expect(result.current.value).toBe("edited\r\n😀\n");
    expect(storage.getItem(legacyNotesKey(cwd))).toBe("edited\r\n😀\n");
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!).reference).toBe("edited\r\n😀\n");
  });

  it("retains an edit in memory when both storage writes fail", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    storage.failingWrites.add(legacyNotesKey(cwd));
    storage.failingWrites.add(v2NotesKey(cwd));
    const hookOptions = options(storage);
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));

    act(() => result.current.onChange("still visible"));

    expect(result.current.value).toBe("still visible");
    expect(result.current.diagnostics.save?.legacy.ok).toBe(false);
    expect(result.current.diagnostics.save?.v2.ok).toBe(false);
  });

  it("loads project B and ignores retained project A callbacks and events", () => {
    const cwdA = "/work/a";
    const cwdB = "/work/b";
    const storage = new ObservableStorage();
    const events = new FakeStorageEvents();
    storage.setItem(legacyNotesKey(cwdA), "A");
    storage.setItem(legacyNotesKey(cwdB), "B");
    const hookOptions = options(storage, events);
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd: string }) => useProjectNotes(cwd, hookOptions),
      { initialProps: { cwd: cwdA } },
    );
    const retainedAChange = result.current.onChange;

    rerender({ cwd: cwdB });
    act(() => retainedAChange("stale A edit"));
    storage.values.set(legacyNotesKey(cwdA), "external A");
    act(() => events.dispatch(legacyNotesKey(cwdA)));

    expect(result.current.value).toBe("B");
    expect(storage.getItem(legacyNotesKey(cwdA))).toBe("external A");
    expect(storage.getItem(legacyNotesKey(cwdB))).toBe("B");
  });

  it("converges equivalent Windows cwd strings through one v2 key and a storage event", () => {
    const firstCwd = "C:\\Work\\Project\\";
    const secondCwd = "c:/work/project";
    const storage = new ObservableStorage();
    const events = new FakeStorageEvents();
    const hookOptions = options(storage, events);
    const first = renderHook(() => useProjectNotes(firstCwd, hookOptions));
    const second = renderHook(() => useProjectNotes(secondCwd, hookOptions));

    act(() => first.result.current.onChange("from first window"));
    act(() => events.dispatch(v2NotesKey(firstCwd), storage.getItem(v2NotesKey(firstCwd))));

    expect(second.result.current.value).toBe("from first window");
    expect(v2NotesKey(firstCwd)).toBe(v2NotesKey(secondCwd));
    expect([...storage.values.keys()].filter((key) => key.startsWith("gg-notes-v2:"))).toEqual([
      v2NotesKey(firstCwd),
    ]);
  });

  it.each(["{", JSON.stringify({ version: 999 })])(
    "opens legacy without fallback writes for malformed/future v2: %s",
    (badV2) => {
      const cwd = "/work/project";
      const storage = new ObservableStorage();
      storage.setItem(legacyNotesKey(cwd), "safe legacy");
      storage.setItem(v2NotesKey(cwd), badV2);
      storage.writeCount = 0;
      const hookOptions = options(storage);

      const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));

      expect(result.current.value).toBe("safe legacy");
      expect(result.current.diagnostics.load?.source).toBe("legacy-fallback");
      expect(storage.writeCount).toBe(0);
      expect(storage.getItem(v2NotesKey(cwd))).toBe(badV2);
    },
  );

  it("uses the latest successful storage event as the whole-document winner", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    const events = new FakeStorageEvents();
    storage.setItem(legacyNotesKey(cwd), "first");
    const hookOptions = options(storage, events);
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));

    storage.values.set(legacyNotesKey(cwd), "second");
    storage.values.set(
      v2NotesKey(cwd),
      JSON.stringify({
        version: 2,
        reference: "second",
        currentFocus: "external focus",
        tasks: [],
        handoff: { text: "", updatedAt: null, readAt: null },
        updatedAt: LATER,
        legacyImportedAt: NOW,
      }),
    );
    act(() => events.dispatch(v2NotesKey(cwd), storage.getItem(v2NotesKey(cwd))));

    expect(result.current.value).toBe("second");
    expect(result.current.diagnostics.load?.document.currentFocus).toBe("external focus");
  });

  it("creates a deterministic task and appends it without changing legacy Reference", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    storage.setItem(legacyNotesKey(cwd), "reference bytes\r\n😀");
    const hookOptions = { ...options(storage), idFactory: () => "task-1" };
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));

    act(() => result.current.createTask("  Write tests  "));

    expect(result.current.document.tasks).toEqual([
      {
        id: "task-1",
        text: "Write tests",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
    ]);
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!)).toEqual(result.current.document);
    expect(storage.getItem(legacyNotesKey(cwd))).toBe("reference bytes\r\n😀");
  });

  it("edits a task while preserving identity, order, status, and lifecycle timestamps", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    let now = NOW;
    let id = 0;
    const clock = (): string => now;
    const hookOptions = {
      storage,
      repository: createNotesRepository(storage, clock),
      eventTarget: new FakeStorageEvents(),
      clock,
      idFactory: () => `task-${++id}`,
    };
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));
    act(() => result.current.createTask("first"));
    act(() => result.current.createTask("second"));
    const original = result.current.document.tasks[0]!;
    now = LATER;

    act(() => result.current.editTask("task-1", "  edited  "));

    const edited = result.current.document.tasks[0]!;
    expect(edited).toEqual({ ...original, text: "edited", updatedAt: LATER });
    expect(result.current.document.tasks.map(({ text }) => text)).toEqual(["edited", "second"]);
    expect(result.current.document.updatedAt).toBe(LATER);
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!).tasks).toEqual(
      result.current.document.tasks,
    );
  });

  it("completes then reopens a task without reordering it", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    let now = NOW;
    let id = 0;
    const clock = (): string => now;
    const hookOptions = {
      storage,
      repository: createNotesRepository(storage, clock),
      eventTarget: new FakeStorageEvents(),
      clock,
      idFactory: () => `task-${++id}`,
    };
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));
    act(() => result.current.createTask("first"));
    act(() => result.current.createTask("second"));
    now = LATER;

    act(() => result.current.toggleTask("task-1"));
    expect(result.current.document.tasks[0]).toMatchObject({ status: "done", completedAt: LATER });
    act(() => result.current.toggleTask("task-1"));
    expect(result.current.document.tasks[0]).toMatchObject({ status: "todo", completedAt: null });
    expect(result.current.document.tasks.map(({ id: taskId }) => taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!).tasks).toEqual(
      result.current.document.tasks,
    );
  });

  it("soft-archives once without deleting or changing task status", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    let now = NOW;
    const clock = (): string => now;
    const hookOptions = {
      storage,
      repository: createNotesRepository(storage, clock),
      eventTarget: new FakeStorageEvents(),
      clock,
      idFactory: () => "task-1",
    };
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));
    act(() => result.current.createTask("archive me"));
    now = LATER;
    act(() => result.current.archiveTask("task-1"));
    const writes = storage.writeCount;

    act(() => result.current.archiveTask("task-1"));

    expect(result.current.document.tasks).toHaveLength(1);
    expect(result.current.document.tasks[0]).toMatchObject({
      status: "todo",
      archivedAt: LATER,
    });
    expect(storage.writeCount).toBe(writes);
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!).tasks).toEqual(
      result.current.document.tasks,
    );
  });

  it("preserves handoff bytes and clears its read timestamp", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    storage.setItem(
      v2NotesKey(cwd),
      JSON.stringify({
        version: 2,
        reference: "ref",
        currentFocus: "",
        tasks: [],
        handoff: { text: "old", updatedAt: NOW, readAt: NOW },
        updatedAt: NOW,
        legacyImportedAt: null,
      }),
    );
    const hookOptions = { ...options(storage), clock: () => LATER };
    hookOptions.repository = createNotesRepository(storage, hookOptions.clock);
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));
    const handoff = "  next\r\nمرحبا 😀\n\n";

    act(() => result.current.changeHandoff(handoff));

    expect(result.current.document.handoff).toEqual({
      text: handoff,
      updatedAt: LATER,
      readAt: null,
    });
    expect(result.current.document.updatedAt).toBe(LATER);
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!).handoff.text).toBe(handoff);
  });

  it("does not persist invalid or unchanged structured mutations", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    const hookOptions = { ...options(storage), idFactory: () => "task-1" };
    const { result } = renderHook(() => useProjectNotes(cwd, hookOptions));
    act(() => result.current.createTask("kept"));
    let writes = storage.writeCount;

    act(() => {
      result.current.createTask("  \n ");
      result.current.editTask("task-1", "   ");
      result.current.editTask("task-1", "kept");
      result.current.editTask("missing", "changed");
      result.current.toggleTask("missing");
      result.current.archiveTask("missing");
      result.current.changeHandoff("");
    });
    expect(storage.writeCount).toBe(writes);

    act(() => result.current.archiveTask("task-1"));
    writes = storage.writeCount;
    act(() => {
      result.current.editTask("task-1", "changed");
      result.current.archiveTask("task-1");
    });

    expect(storage.writeCount).toBe(writes);
  });

  it("ignores retained structured callbacks after switching projects", () => {
    const storage = new ObservableStorage();
    const hookOptions = { ...options(storage), idFactory: () => "task-1" };
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd: string }) => useProjectNotes(cwd, hookOptions),
      { initialProps: { cwd: "/work/a" } },
    );
    const retained = {
      create: result.current.createTask,
      edit: result.current.editTask,
      toggle: result.current.toggleTask,
      archive: result.current.archiveTask,
      handoff: result.current.changeHandoff,
    };
    rerender({ cwd: "/work/b" });
    const writes = storage.writeCount;

    act(() => {
      retained.create("stale");
      retained.edit("missing", "stale");
      retained.toggle("missing");
      retained.archive("missing");
      retained.handoff("stale");
    });

    expect(result.current.document.tasks).toEqual([]);
    expect(result.current.document.handoff.text).toBe("");
    expect(storage.writeCount).toBe(writes);
  });

  it("applies tasks and handoff from a v2 storage event as the whole-document winner", () => {
    const cwd = "/work/project";
    const storage = new ObservableStorage();
    const events = new FakeStorageEvents();
    const hookOptions = options(storage, events);
    const first = renderHook(() => useProjectNotes(cwd, hookOptions));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions));
    act(() => first.result.current.createTask("external task"));
    act(() => first.result.current.changeHandoff("external\n😀"));

    act(() => events.dispatch(v2NotesKey(cwd), storage.getItem(v2NotesKey(cwd))));

    expect(second.result.current.document).toEqual(first.result.current.document);
    expect(second.result.current.document.tasks[0]?.text).toBe("external task");
    expect(second.result.current.document.handoff.text).toBe("external\n😀");
  });

  it("removes its storage listener on unmount", () => {
    const storage = new ObservableStorage();
    const events = new FakeStorageEvents();
    const hookOptions = options(storage, events);
    const { unmount } = renderHook(() => useProjectNotes("/work/project", hookOptions));

    expect(events.listeners.size).toBe(1);
    unmount();
    expect(events.listeners.size).toBe(0);
  });
});
