// @vitest-environment jsdom
import { useState } from "react";
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
    sourceRevision: "a".repeat(40),
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
    mocks.checkLocal.mockResolvedValue({
      available: false,
      currentSourceSha: "abc123",
      upstreamIntegrated: false,
      origin: "unavailable",
    });
  });

  it.each([
    ["fresh", true, "available"],
    ["cached", true, "available"],
    ["unavailable", false, "idle"],
  ] as const)("preserves banner behavior for %s status", async (origin, available, phase) => {
    mocks.checkLocal.mockResolvedValue({
      available,
      currentSourceSha: "abc123",
      upstreamIntegrated: !available,
      origin,
    });
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current.phase).toBe(phase));
    expect(mocks.checkLocal).toHaveBeenCalledWith("C:/fork", "a".repeat(40));
    expect(mocks.check).not.toHaveBeenCalled();
    expect(result.current.localPatched).toBe(true);
  });

  it("renders and updates unrelated state while native status is pending", () => {
    mocks.checkLocal.mockReturnValue(new Promise(() => undefined));
    const { result, unmount } = renderHook(() => {
      const update = useAppUpdate();
      const [count, setCount] = useState(0);
      return { update, count, setCount };
    });

    expect(result.current.update.phase).toBe("checking");
    act(() => result.current.setCount(1));
    expect(result.current.count).toBe(1);
    expect(result.current.update.phase).toBe("checking");
    unmount();
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

  it("waits for local listener readiness before starting exactly once", async () => {
    let resolveRegistration!: (cleanup: () => void) => void;
    mocks.listenLocal.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveRegistration = resolve;
      }),
    );
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(mocks.listenLocal).toHaveBeenCalledOnce());

    let installPromise!: Promise<void>;
    act(() => {
      installPromise = result.current.install();
    });
    await Promise.resolve();
    expect(mocks.startLocal).not.toHaveBeenCalled();

    await act(async () => {
      resolveRegistration(vi.fn());
      await installPromise;
    });
    expect(mocks.startLocal).toHaveBeenCalledOnce();
  });

  it("reports listener registration failure without starting the local update", async () => {
    let rejectRegistration!: (error: Error) => void;
    mocks.listenLocal.mockReturnValue(
      new Promise<() => void>((_resolve, reject) => {
        rejectRegistration = reject;
      }),
    );
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(mocks.listenLocal).toHaveBeenCalledOnce());

    let installPromise!: Promise<void>;
    act(() => {
      installPromise = result.current.install();
    });
    await Promise.resolve();
    expect(mocks.startLocal).not.toHaveBeenCalled();

    await act(async () => {
      rejectRegistration(new Error("listener unavailable"));
      await installPromise;
    });
    expect(result.current.phase).toBe("error");
    expect(result.current.statusMessage).toContain(
      "Could not listen for update progress: Error: listener unavailable",
    );
    expect(mocks.startLocal).not.toHaveBeenCalled();
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
