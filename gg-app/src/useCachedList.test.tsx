// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_RETRY_DELAYS_MS, useCachedList } from "./useCachedList";

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useCachedList", () => {
  it("shows the skeleton on a first visit, then the list", async () => {
    const load = deferred<string[]>();
    const { result } = renderHook(() => useCachedList("projects", () => load.promise));
    expect(result.current.loading).toBe(true);
    await act(async () => load.resolve(["a", "b"]));
    expect(result.current).toMatchObject({ loading: false, items: ["a", "b"], error: null });
  });

  it("shows the kept copy at once on a return visit, then swaps in the refresh", async () => {
    const first = renderHook(() => useCachedList("projects", () => Promise.resolve(["a"])));
    await waitFor(() => expect(first.result.current.items).toEqual(["a"]));
    first.unmount();

    const refresh = deferred<string[]>();
    const { result } = renderHook(() => useCachedList("projects", () => refresh.promise));
    // No skeleton: the last copy is on screen while the refresh runs.
    expect(result.current).toMatchObject({ loading: false, items: ["a"] });
    await act(async () => refresh.resolve(["a", "new"]));
    expect(result.current.items).toEqual(["a", "new"]);
  });

  it("keeps the kept copy on screen when a refresh fails", async () => {
    sessionStorage.setItem("gg-list:chats", JSON.stringify(["kept"]));
    const refresh = deferred<string[]>();
    const { result } = renderHook(() => useCachedList("chats", () => refresh.promise));
    await act(async () => refresh.reject(new Error("offline")));
    expect(result.current).toMatchObject({ items: ["kept"], error: null, loading: false });
  });

  it("reports an error only when there's nothing to show", async () => {
    const { result } = renderHook(() =>
      useCachedList("goals", () => Promise.reject(new Error("offline"))),
    );
    await waitFor(() => expect(result.current.error).toBe("offline"));
    expect(result.current.items).toEqual([]);
  });

  it("never shows one key's rows under another", async () => {
    sessionStorage.setItem("gg-list:sessions:/a", JSON.stringify(["a1"]));
    const { result, rerender } = renderHook(
      ({ k }) => useCachedList<string>(k, () => new Promise(() => {})),
      { initialProps: { k: "sessions:/a" } },
    );
    expect(result.current.items).toEqual(["a1"]);
    rerender({ k: "sessions:/b" });
    expect(result.current).toMatchObject({ items: [], loading: true });
  });

  describe("refresh behind a kept copy", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("retries a failed refresh, then swaps in the new list", async () => {
      sessionStorage.setItem("gg-list:sessions:/p", JSON.stringify(["old"]));
      let calls = 0;
      const { result } = renderHook(() =>
        useCachedList("sessions:/p", () => {
          calls += 1;
          // The daemon is still starting on the first ask (the regression).
          return calls === 1
            ? Promise.reject(new Error("session not ready"))
            : Promise.resolve(["new", "old"]);
        }),
      );
      await act(async () => {});
      expect(result.current).toMatchObject({ items: ["old"], refreshError: null });

      await act(async () => vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAYS_MS[0]));
      expect(calls).toBe(2);
      expect(result.current).toMatchObject({
        items: ["new", "old"],
        refreshError: null,
        error: null,
      });
    });

    it("flags the kept copy as possibly out of date once retries run out", async () => {
      sessionStorage.setItem("gg-list:sessions:/p", JSON.stringify(["old"]));
      let calls = 0;
      const { result } = renderHook(() =>
        useCachedList("sessions:/p", () => {
          calls += 1;
          return Promise.reject(new Error("daemon not ready"));
        }),
      );
      await act(async () => {});
      for (const delay of REFRESH_RETRY_DELAYS_MS) {
        expect(result.current.refreshError).toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(delay));
      }
      expect(calls).toBe(REFRESH_RETRY_DELAYS_MS.length + 1);
      // Still shown (never blanked), but no longer passed off as current.
      expect(result.current).toMatchObject({
        items: ["old"],
        error: null,
        loading: false,
        refreshError: "daemon not ready",
      });
    });

    it("clears the flag when a manual reload succeeds", async () => {
      sessionStorage.setItem("gg-list:sessions:/p", JSON.stringify(["old"]));
      let fail = true;
      const { result } = renderHook(() =>
        useCachedList("sessions:/p", () =>
          fail ? Promise.reject(new Error("offline")) : Promise.resolve(["fresh"]),
        ),
      );
      await act(async () => {});
      for (const delay of REFRESH_RETRY_DELAYS_MS) {
        await act(async () => vi.advanceTimersByTimeAsync(delay));
      }
      expect(result.current.refreshError).toBe("offline");

      fail = false;
      await act(async () => result.current.reload());
      expect(result.current).toMatchObject({ items: ["fresh"], refreshError: null });
    });

    it("stops retrying once unmounted", async () => {
      sessionStorage.setItem("gg-list:sessions:/p", JSON.stringify(["old"]));
      let calls = 0;
      const { unmount } = renderHook(() =>
        useCachedList("sessions:/p", () => {
          calls += 1;
          return Promise.reject(new Error("offline"));
        }),
      );
      await act(async () => {});
      unmount();
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(calls).toBe(1);
    });
  });
});
