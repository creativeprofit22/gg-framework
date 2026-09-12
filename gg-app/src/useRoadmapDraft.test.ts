// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PaneAgentClient } from "./agent";
import { useRoadmapDraft } from "./useRoadmapDraft";
const draft = {
  id: "d1",
  projectKey: "/work",
  basedOnRevision: 1,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "s1",
  summary: "Review",
  references: [],
  phases: [
    {
      phaseId: "p1",
      title: "Phase",
      goal: "Goal",
      doneWhen: ["Done"],
      sourcePrompt: "Build",
      referenceIds: [],
    },
  ],
  status: "pending" as const,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function client(get = vi.fn().mockResolvedValue(draft)) {
  return {
    getRoadmapPhaseDraft: get,
    approveRoadmapPhaseDraft: vi
      .fn()
      .mockResolvedValue({ status: "created", revision: 2, phaseIds: ["p1"] }),
    rejectRoadmapPhaseDraft: vi.fn().mockResolvedValue({ status: "rejected" }),
  } as unknown as PaneAgentClient;
}
describe("useRoadmapDraft", () => {
  it("does not resurrect an approved draft from a late refresh", async () => {
    const pending = deferred<unknown>();
    const get = vi.fn().mockResolvedValueOnce(draft).mockReturnValueOnce(pending.promise);
    const c = client(get);
    const hook = renderHook(() => useRoadmapDraft(c, "one", true));
    await waitFor(() => expect(hook.result.current.state.draft).toEqual(draft));
    act(() => hook.result.current.refresh());
    act(() => hook.result.current.approve());
    await waitFor(() => expect(hook.result.current.state.draft).toBeNull());
    await act(async () => pending.resolve(draft));
    expect(hook.result.current.state.draft).toBeNull();
    expect(c.approveRoadmapPhaseDraft).toHaveBeenCalledOnce();
  });

  it("ignores an old decision after a different draft arrives", async () => {
    const decision = deferred<unknown>();
    const c = client();
    vi.mocked(c.approveRoadmapPhaseDraft).mockReturnValueOnce(
      decision.promise as ReturnType<PaneAgentClient["approveRoadmapPhaseDraft"]>,
    );
    const hook = renderHook(() => useRoadmapDraft(c, "one", true));
    await waitFor(() => expect(hook.result.current.state.draft).toEqual(draft));
    act(() => {
      hook.result.current.approve();
      hook.result.current.approve();
    });
    const next = { ...draft, id: "next" };
    act(() => hook.result.current.onChange(next));
    await act(async () => decision.resolve({ status: "created", revision: 2, phaseIds: ["p1"] }));
    expect(hook.result.current.state.draft).toEqual(next);
    expect(hook.result.current.state.decision).toBe("idle");
    expect(c.approveRoadmapPhaseDraft).toHaveBeenCalledOnce();
  });

  it("does not launch queued refreshes after unmount", async () => {
    const pending = deferred<unknown>();
    const get = vi.fn().mockReturnValue(pending.promise);
    const c = client(get);
    const hook = renderHook(() => useRoadmapDraft(c, "one", true));
    act(() => hook.result.current.refresh());
    hook.unmount();
    await act(async () => pending.resolve(draft));
    expect(get).toHaveBeenCalledOnce();
  });
  it("coalesces bursts and ignores results from a previous session", async () => {
    const old = deferred<unknown>();
    const get = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(null);
    const c = client(get);
    const hook = renderHook(({ scope }) => useRoadmapDraft(c, scope, true), {
      initialProps: { scope: "one" },
    });
    act(() => {
      hook.result.current.refresh();
      hook.result.current.refresh();
    });
    expect(get).toHaveBeenCalledTimes(1);
    hook.rerender({ scope: "two" });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve(draft));
    expect(hook.result.current.state.draft).toBeNull();
  });
  it("keeps pending content on malformed response and offers retry after network failure", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({ bad: true })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(null);
    const clientInstance = client(get);
    const hook = renderHook(() => useRoadmapDraft(clientInstance, "one", true));
    await waitFor(() => expect(hook.result.current.state.draft).toEqual(draft));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.refreshError).toContain("Invalid"));
    expect(hook.result.current.state.draft).toEqual(draft);
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.refreshError).toBe("offline"));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.state.draft).toBeNull());
    expect(hook.result.current.refreshError).toBeNull();
  });
});
