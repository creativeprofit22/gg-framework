// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_MAX_BYTES,
  APPEARANCE_STORAGE_KEY as key,
  DEFAULT_APPEARANCE,
  createAppearanceOwner,
  parseAppearance,
} from "./appearance";

describe("appearance preferences", () => {
  const cleanups: (() => void)[] = [];
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    vi.restoreAllMocks();
  });
  function owner(transient = false) {
    const root = document.createElement("div");
    const value = createAppearanceOwner(window, root, transient);
    cleanups.push(value.start());
    return { ...value, root };
  }
  function external(raw: string | null, storageKey: string | null = key) {
    window.dispatchEvent(
      new StorageEvent("storage", { key: storageKey, newValue: raw, storageArea: localStorage }),
    );
  }
  it("uses the unchanged Dark reading defaults without writing", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const a = owner();
    expect(a.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    expect(a.root.dataset.appearanceTheme).toBe("dark");
    expect(a.root.style.colorScheme).toBe("dark");
    expect(a.root.style.getPropertyValue("--reading-prose-size")).toBe("15px");
    expect(write).not.toHaveBeenCalled();
  });
  it.each([null, "", "{", "null", "[]", "true", "42", "x".repeat(APPEARANCE_MAX_BYTES + 1)])(
    "rejects invalid storage %s",
    (raw) => {
      expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
    },
  );
  it("validates each field and excludes unknown keys", () => {
    expect(
      parseAppearance(
        JSON.stringify({
          theme: "light",
          size: "72",
          tracking: "normal",
          paragraphs: "roomy",
          cap: "on",
          markers: "on",
          streaming: "crisp",
          extra: "ignored",
          __proto__: { size: "16" },
        }),
      ),
    ).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: "light",
      tracking: "normal",
      paragraphs: "roomy",
      cap: "on",
      markers: "on",
      streaming: "crisp",
    });
  });
  it("saves, reloads and resets only its dedicated preference record", () => {
    localStorage.setItem("gg-app:zoom", "1.5");
    const a = owner();
    const listener = vi.fn();
    const unsubscribe = a.subscribe(listener);
    a.update({ theme: "light", size: "16" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(a.root.dataset.appearanceTheme).toBe("light");
    expect(owner().getSnapshot().preferences).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: "light",
      size: "16",
    });
    a.reset();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(DEFAULT_APPEARANCE);
    expect(localStorage.getItem("gg-app:zoom")).toBe("1.5");
    unsubscribe();
    a.update({ theme: "light" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("merges edits against the latest valid storage record", () => {
    const a = owner();
    localStorage.setItem(key, JSON.stringify({ theme: "light", markers: "on" }));
    a.update({ size: "16" });
    expect(a.getSnapshot().preferences).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: "light",
      markers: "on",
      size: "16",
    });
  });
  it("syncs other windows and removals without echo writes, and tears down", () => {
    const a = owner();
    const write = vi.spyOn(Storage.prototype, "setItem");
    external(JSON.stringify({ theme: "light" }));
    expect(a.root.style.colorScheme).toBe("light");
    external(null);
    expect(a.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    external(JSON.stringify({ theme: "light" }));
    external(null, null);
    expect(a.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    external(JSON.stringify({ theme: "light" }), "unrelated");
    expect(a.getSnapshot().preferences.theme).toBe("dark");
    expect(write).not.toHaveBeenCalled();
    cleanups.splice(0).forEach((stop) => stop());
    external(JSON.stringify({ theme: "light" }));
    expect(a.getSnapshot().preferences.theme).toBe("dark");
  });
  it("keeps failed saves in session, warns, and retries all unsaved choices", () => {
    const a = owner();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    a.update({ theme: "light" });
    a.update({ size: "16" });
    expect(a.getSnapshot().preferences.theme).toBe("light");
    expect(a.getSnapshot().persistenceWarning).toContain("could not be saved");
    write.mockRestore();
    a.update({ markers: "on" });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: "light",
      size: "16",
      markers: "on",
    });
    expect(a.getSnapshot().persistenceWarning).toBeNull();
  });
  it("handles denied reads without breaking document initialization", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const a = owner();
    expect(a.root.style.colorScheme).toBe("dark");
    expect(a.getSnapshot().persistenceWarning).toContain("unavailable");
  });
  it("captures before reflow, restores before notification, and removes the capture subscription", async () => {
    const a = owner();
    const order: string[] = [];
    const unsubscribe = a.beforeApply(() => {
      order.push(`capture:${a.root.dataset.appearanceSize}`);
      return () => {
        order.push(`restore:${a.root.dataset.appearanceSize}`);
      };
    });
    const stopListener = a.subscribe(() => {
      order.push("notify");
    });
    a.update({ size: "16" });
    expect(order).toEqual(["capture:15", "restore:16", "notify"]);
    a.update({ size: "16" });
    expect(order).toHaveLength(3);
    await Promise.resolve(); // Real storage events arrive in a later task.
    external(JSON.stringify({ size: "15" }));
    expect(order.slice(3)).toEqual(["capture:16", "restore:15", "notify"]);
    await Promise.resolve();
    unsubscribe();
    stopListener();
    a.update({ size: "16" });
    expect(order).toHaveLength(6);
  });
  it("retains the same reading anchor across synchronous preference changes", async () => {
    const a = owner();
    const restore = vi.fn();
    const capture = vi.fn(() => restore);
    a.beforeApply(capture);
    a.update({ size: "16" });
    a.update({ tracking: "normal" });
    a.update({ paragraphs: "roomy" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    a.update({ cap: "on" });
    expect(capture).toHaveBeenCalledTimes(2);
  });
  it("leaves preview comparison DOM and storage isolated", () => {
    localStorage.setItem(key, JSON.stringify({ theme: "light" }));
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const a = owner(true);
    a.update({ size: "16" });
    a.reset();
    external(JSON.stringify({ theme: "light" }));
    expect(a.root.attributes).toHaveLength(0);
    expect(a.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
