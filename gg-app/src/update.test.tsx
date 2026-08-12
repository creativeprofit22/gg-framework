// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  checkLocal: vi.fn(),
  listenLocal: vi.fn(),
  startLocal: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  buildInfo: {
    localPatched: true,
    sourceRoot: "C:/fork",
    customLabel: "Local Fork",
    gitSha: "abc123",
  },
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-log", () => ({ info: mocks.info, error: mocks.error }));
vi.mock("./build-info", () => ({ appBuildInfo: mocks.buildInfo }));
vi.mock("./agent", () => ({
  checkLocalPatchedUpdate: mocks.checkLocal,
  listenLocalPatchedUpdate: mocks.listenLocal,
  startLocalPatchedUpdate: mocks.startLocal,
}));

import { useAppUpdate } from "./update";

describe("useAppUpdate local-fork isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildInfo.localPatched = true;
    mocks.listenLocal.mockResolvedValue(vi.fn());
    mocks.checkLocal.mockResolvedValue({ available: false });
  });

  it("uses only the native local check and exposes availability", async () => {
    mocks.checkLocal.mockResolvedValue({ available: true, version: "5.40.0" });
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current.phase).toBe("available"));
    expect(mocks.checkLocal).toHaveBeenCalledWith("C:/fork", "abc123");
    expect(mocks.check).not.toHaveBeenCalled();
    expect(result.current.localPatched).toBe(true);
  });

  it("returns to idle when unavailable or the native check rejects", async () => {
    const first = renderHook(() => useAppUpdate());
    await waitFor(() => expect(first.result.current.phase).toBe("idle"));
    first.unmount();
    mocks.checkLocal.mockRejectedValueOnce(new Error("offline"));
    const second = renderHook(() => useAppUpdate());
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("offline")),
    );
    expect(second.result.current.phase).toBe("idle");
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("handles malformed local responses without exposing production state", async () => {
    mocks.checkLocal.mockResolvedValue(null);
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(result.current.phase).toBe("idle");
    expect(result.current.version).toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("preserves installing and completed phases across poll results", async () => {
    let listener: ((event: { type: string; installerPath?: string }) => void) | undefined;
    mocks.listenLocal.mockImplementation(async (callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(listener).toBeDefined());
    act(() => listener?.({ type: "started" }));
    await waitFor(() => expect(result.current.phase).toBe("installing"));
    act(() => listener?.({ type: "completed", installerPath: "C:/installer.exe" }));
    expect(result.current.phase).toBe("completed");
    expect(result.current.installerPath).toBe("C:/installer.exe");
  });

  it("never registers local listeners or calls local endpoints in production", async () => {
    mocks.buildInfo.localPatched = false;
    mocks.check.mockResolvedValue(null);
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.checkLocal).not.toHaveBeenCalled();
    expect(mocks.listenLocal).not.toHaveBeenCalled();
  });
});
