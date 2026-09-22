// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appearance } from "./appearance";
import type * as TauriCore from "@tauri-apps/api/core";
const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(async (..._args: unknown[]) => {}),
  toast: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  isTauri: mocks.isTauri,
}));
// Keep the real SDK window and core invoke: observe the final serialized boundary.
let label = "main";
beforeEach(() => {
  label = "main";
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: mocks.invoke,
      metadata: {
        get currentWindow() {
          return { label };
        },
      },
    },
  });
});
vi.mock("./toast", () => ({ toast: mocks.toast }));
import { createNativeAppearanceSync, startNativeAppearance } from "./appearance-native";
// The real SDK adds async adoption turns; drain the microtask queue, not a fixed count.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("native appearance", () => {
  it("initializes each window from saved settings and ignores reading-only changes", async () => {
    localStorage.setItem("gg-app:appearance:v1", JSON.stringify({ theme: "light" }));
    const stopOwner = appearance.start();
    const first = startNativeAppearance();
    await flush();
    expect(mocks.invoke.mock.calls).toEqual([
      ["plugin:window|set_theme", { label: "main", value: "light" }, undefined],
      ["plugin:window|set_background_color", { label: "main", value: "#fcfbfd" }, undefined],
    ]);
    appearance.update({ size: "16" });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const second = startNativeAppearance();
    await flush();
    expect(mocks.invoke).toHaveBeenCalledTimes(4);
    first();
    second();
    stopOwner();
  });
  it.each(["main", "project-regression", "whatsnew"])(
    "serializes both colors for the actual %s window",
    async (currentLabel) => {
      label = currentLabel;
      const stopOwner = appearance.start();
      appearance.update({ theme: "dark" });
      const stop = startNativeAppearance();
      await flush();
      appearance.update({ theme: "light" });
      await flush();
      expect(mocks.invoke.mock.calls).toEqual([
        ["plugin:window|set_theme", { label, value: "dark" }, undefined],
        ["plugin:window|set_background_color", { label, value: "#0f1115" }, undefined],
        ["plugin:window|set_theme", { label, value: "light" }, undefined],
        ["plugin:window|set_background_color", { label, value: "#fcfbfd" }, undefined],
      ]);
      stop();
      stopOwner();
    },
  );
  it("reports background IPC rejection and recovers on the next theme", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invoke.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("denied"));
    const stopOwner = appearance.start();
    appearance.update({ theme: "dark" });
    const stop = startNativeAppearance();
    await flush();
    await flush();
    expect(mocks.toast).toHaveBeenCalledOnce();
    appearance.update({ theme: "light" });
    await flush();
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "plugin:window|set_background_color",
      { label: "main", value: "#fcfbfd" },
      undefined,
    );
    stop();
    stopOwner();
  });
  it("serializes and coalesces rapid toggles so the latest native update wins", async () => {
    let resolve!: () => void;
    const target = {
      setTheme: vi
        .fn<(_: "dark" | "light") => Promise<void>>()
        .mockImplementationOnce(
          () =>
            new Promise<void>((r) => {
              resolve = r;
            }),
        )
        .mockResolvedValue(undefined),
      setBackgroundColor: vi.fn(async () => {}),
    };
    const sync = createNativeAppearanceSync(target, vi.fn());
    sync.update("dark");
    sync.update("light");
    sync.update("dark");
    sync.update("light");
    expect(target.setTheme).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(target.setTheme.mock.calls.map(([theme]) => theme)).toEqual(["dark", "light"]);
    expect(target.setBackgroundColor.mock.calls).toEqual([["#fcfbfd"]]);
    sync.stop();
  });
  it("reports failure without preventing subsequent changes", async () => {
    const report = vi.fn();
    const target = {
      setTheme: vi
        .fn()
        .mockRejectedValueOnce(new Error("permission denied"))
        .mockResolvedValue(undefined),
      setBackgroundColor: vi.fn(async () => {}),
    };
    const sync = createNativeAppearanceSync(target, report);
    sync.update("light");
    await flush();
    expect(report).toHaveBeenCalledOnce();
    sync.update("dark");
    await flush();
    expect(target.setBackgroundColor).toHaveBeenLastCalledWith("#0f1115");
    sync.stop();
  });
  it("does not issue background work after teardown", async () => {
    let resolve!: () => void;
    const target = {
      setTheme: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      ),
      setBackgroundColor: vi.fn(async () => {}),
    };
    const sync = createNativeAppearanceSync(target, vi.fn());
    sync.update("light");
    sync.stop();
    resolve();
    await flush();
    sync.update("dark");
    expect(target.setTheme).toHaveBeenCalledOnce();
    expect(target.setBackgroundColor).not.toHaveBeenCalled();
  });
  it("never calls native setters in a regular browser", () => {
    mocks.isTauri.mockReturnValueOnce(false);
    startNativeAppearance()();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
