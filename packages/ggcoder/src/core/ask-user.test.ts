import { describe, expect, it, vi } from "vitest";
import { ASK_USER_MAX_PENDING, ASK_USER_MAX_PROMPT_CHARS, isPendingAskSnapshot } from "@kenkaiiii/gg-core/desktop-session-ux";
import { createAskUserBridge, type AskUserRequest } from "./ask-user.js";

const request: AskUserRequest = { questions: [{ id: "review", kind: "choice", question: "Create reviewed files?",
  detail: "Exact preview\n" + "+ file contents\n".repeat(4_000), allowOther: false,
  options: [{ label: "Create reviewed files", value: "host-content-hash-and-nonce", hint: "Does not run files" },
    { label: "Do not create files", value: "reject", recommended: true }] }] };

describe("live question snapshots", () => {
  it("recovers the exact missed event without settling or extending the question", async () => {
    vi.useFakeTimers();
    const broadcast = vi.fn();
    const onSettled = vi.fn();
    const bridge = createAskUserBridge({ broadcast, onSettled, timeoutMs: 1_000 });
    try {
      const result = bridge.park(request);
      const snapshot = bridge.pendingRequests;
      expect(snapshot).toEqual([broadcast.mock.calls[0]![0]]);
      expect(snapshot[0]!.questions).toEqual(request.questions);
      expect(isPendingAskSnapshot(snapshot)).toBe(true);
      await vi.advanceTimersByTimeAsync(900);
      expect(bridge.pendingRequests).toEqual(snapshot);
      expect(onSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toEqual({ action: "cancel" });
      expect(bridge.pendingRequests).toEqual([]);
      expect(onSettled).toHaveBeenCalledExactlyOnceWith({ id: snapshot[0]!.id, action: "cancel" });
    } finally { bridge.cancelAll(); vi.useRealTimers(); }
  });

  it("detaches snapshots and admitted inputs, and removes answered questions", async () => {
    const bridge = createAskUserBridge({ broadcast: () => {} });
    const input = structuredClone(request);
    const result = bridge.park(input);
    const snapshot = bridge.pendingRequests;
    input.questions[0]!.detail = "mutated input";
    snapshot[0]!.questions[0]!.options![0]!.value = "mutated snapshot";
    expect(bridge.pendingRequests[0]!.questions).toEqual(request.questions);
    const id = snapshot[0]!.id;
    expect(bridge.settle(id, { action: "answer", answers: { review: "host-content-hash-and-nonce" } })).toBe(true);
    expect(await result).toEqual({ action: "answer", answers: { review: "host-content-hash-and-nonce" } });
    expect(bridge.pendingRequests).toEqual([]);
    expect(bridge.settle(id, { action: "cancel" })).toBe(false);
  });

  it("starts a fresh daemon bridge empty and rejects old request identities", async () => {
    const old = createAskUserBridge({ broadcast: () => {} });
    const previous = old.park(request);
    const oldId = old.pendingRequests[0]!.id;
    old.cancelAll();
    expect(await previous).toEqual({ action: "cancel" });
    const fresh = createAskUserBridge({ broadcast: () => {} });
    expect(fresh.pendingRequests).toEqual([]);
    expect(fresh.settle(oldId, { action: "answer", answers: { review: "host-content-hash-and-nonce" } })).toBe(false);
    const current = fresh.park(request);
    expect(fresh.pendingRequests[0]!.id).not.toBe(oldId);
    expect(fresh.settle(oldId, { action: "answer", answers: { review: "host-content-hash-and-nonce" } })).toBe(false);
    expect(fresh.pendingCount).toBe(1);
    fresh.cancelAll();
    expect(await current).toEqual({ action: "cancel" });
  });

  it("bounds admission instead of truncating a live snapshot", async () => {
    const bridge = createAskUserBridge({ broadcast: () => {} });
    const pending = Array.from({ length: ASK_USER_MAX_PENDING }, () => bridge.park(request));
    try {
      await expect(bridge.park(request)).rejects.toThrow("live-question limit");
      expect(bridge.pendingRequests).toHaveLength(ASK_USER_MAX_PENDING);
      expect(isPendingAskSnapshot(bridge.pendingRequests)).toBe(true);
    } finally { bridge.cancelAll(); await Promise.all(pending); }
    await expect(bridge.park({ questions: [{ ...request.questions[0]!, detail: "x".repeat(ASK_USER_MAX_PROMPT_CHARS + 1) }] })).rejects.toThrow("invalid content");
    expect(bridge.pendingRequests).toEqual([]);
  });

  it("distinguishes empty from absent and rejects malformed, duplicated, or oversized snapshots", () => {
    expect(isPendingAskSnapshot([])).toBe(true);
    expect(isPendingAskSnapshot(undefined)).toBe(false);
    expect(isPendingAskSnapshot(null)).toBe(false);
    const prompt = { ...request, id: "ask-live" };
    expect(isPendingAskSnapshot([prompt, prompt])).toBe(false);
    for (const changes of [{ kind: "unknown" }, { options: [] }, { allowOther: "yes" },
      { options: [{ label: "Create", value: 1 }] }, { detail: "x".repeat(128_001) }]) {
      expect(isPendingAskSnapshot([{ ...prompt, questions: [{ ...request.questions[0], ...changes }] }])).toBe(false);
    }
    expect(isPendingAskSnapshot(Array.from({ length: ASK_USER_MAX_PENDING + 1 }, (_, i) => ({ ...prompt, id: `ask-${i}` })))).toBe(false);
  });
});
