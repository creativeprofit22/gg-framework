import { expect, it, vi } from "vitest";
import { createParkedRequests } from "./parked-requests.js";

it("projects only live detached requests across answer, timeout and teardown", async () => {
  vi.useFakeTimers();
  const settled = vi.fn();
  const bridge = createParkedRequests<{ detail: { text: string } }, string>({
    idPrefix: "fixture", broadcast: () => {}, cancelValue: () => "cancel",
    timeoutMs: 100, onSettled: settled,
  });
  try {
    expect(bridge.pendingRequests).toEqual([]);
    const first = bridge.park({ detail: { text: "exact preview" } });
    const second = bridge.park({ detail: { text: "second" } });
    const snapshot = bridge.pendingRequests;
    snapshot[0]!.detail.text = "local edit";
    expect(bridge.pendingRequests[0]!.detail.text).toBe("exact preview");
    expect(bridge.settle(snapshot[0]!.id, "answer")).toBe(true);
    expect(await first).toBe("answer");
    expect(bridge.pendingRequests.map((p) => p.id)).toEqual([snapshot[1]!.id]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe("cancel");
    expect(bridge.pendingRequests).toEqual([]);
    const third = bridge.park({ detail: { text: "teardown" } });
    bridge.cancelAll();
    expect(await third).toBe("cancel");
    expect(bridge.pendingRequests).toEqual([]);
    expect(settled).toHaveBeenCalledTimes(3);
  } finally { bridge.cancelAll(); vi.useRealTimers(); }
});
