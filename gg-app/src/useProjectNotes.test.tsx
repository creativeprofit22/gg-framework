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
