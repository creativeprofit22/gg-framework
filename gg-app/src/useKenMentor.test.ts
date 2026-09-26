// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useKenMentor } from "./useKenMentor";
import type { Item } from "./App";
import type { SidecarEvent } from "./agent";

/**
 * Drive the hook with a real (mutable) items array + monotonic id minter, mirroring
 * how App wires it. setItems runs synchronously here, so transcript appends are
 * observable immediately; the hook's own React state (kenRunning, kenTokens, …) is
 * read off result.current after an act() flush.
 */
function setup() {
  let items: Item[] = [];
  let id = 0;
  const setItems = (u: Item[] | ((prev: Item[]) => Item[])): void => {
    items = typeof u === "function" ? u(items) : u;
  };
  const nextId = (): number => ++id;
  const hook = renderHook(() => useKenMentor({ setItems, nextId }));
  act(() => hook.result.current.hydrateKen({ ...identity, activeRunId: identity.runId }));
  return { hook, getItems: () => items };
}

const identity = { conversationId: "conversation", activationEpoch: "epoch", runId: "run" };
const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data: { ken: identity, ...data } }) as SidecarEvent;

describe("useKenMentor", () => {
  it("captures copied idle target authority and isolates pending operations from another pane reset", () => {
    const a = setup();
    const b = setup();
    act(() => a.hook.result.current.hydrateKen({ ...identity, activeRunId: null }));
    const target = a.hook.result.current.captureKenTarget();
    const isCurrent = a.hook.result.current.captureKenOperation();
    expect(target).toEqual({ conversationId: "conversation", activationEpoch: "epoch" });
    target!.activationEpoch = "mutated";
    act(() =>
      b.hook.result.current.hydrateKen(
        { ...identity, activationEpoch: "rewound", activeRunId: null },
        true,
      ),
    );
    expect(isCurrent()).toBe(true);
    expect(a.hook.result.current.captureKenTarget()?.activationEpoch).toBe("epoch");
    act(() => a.hook.result.current.hydrateKen(null));
    expect(isCurrent()).toBe(false);
    expect(a.hook.result.current.captureKenTarget()).toBeNull();
  });
  it("never revives pending operations after a same-conversation epoch changes and returns", () => {
    const { hook } = setup();
    const isCurrent = hook.result.current.captureKenOperation();
    act(() => {
      hook.result.current.hydrateKen(
        { ...identity, activationEpoch: "rewound", activeRunId: identity.runId },
        true,
      );
      hook.result.current.hydrateKen({ ...identity, activeRunId: identity.runId }, true);
    });
    expect(isCurrent()).toBe(false);
    expect(hook.result.current.captureKenOperation()()).toBe(true);
  });
  it.each([null, undefined, "bad", 42, false, []].map((data) => ({ data })))(
    "consumes malformed mentor payload $data without changing state",
    ({ data }) => {
      const { hook, getItems } = setup();
      for (const type of [
        "ken_run_start",
        "ken_text_delta",
        "ken_thinking_delta",
        "ken_tool_call_start",
        "ken_tool_call_end",
        "ken_run_end",
        "ken_error",
      ]) {
        act(() =>
          expect(hook.result.current.handleKenEvent({ type, data } as SidecarEvent)).toBe(true),
        );
      }
      expect(getItems()).toEqual([]);
      expect(hook.result.current.captureKenRun()).toEqual(identity);
      expect(hook.result.current.kenRunning).toBe(true);
      expect(hook.result.current.handleKenEvent({ type: "text_delta", data } as SidecarEvent)).toBe(
        false,
      );
    },
  );
  it("uses ready authority on reconnect and clears missing authority without learning from a model change", () => {
    const { hook, getItems } = setup();
    act(() =>
      hook.result.current.handleKenEvent(
        ev("ready", { kenState: { ...identity, activeRunId: "reconnected" } }),
      ),
    );
    act(() =>
      hook.result.current.handleKenEvent(
        ev("ken_text_delta", { ken: { ...identity, runId: "reconnected" }, text: "resumed" }),
      ),
    );
    expect(getItems()).toMatchObject([{ text: "resumed" }]);
    act(() => hook.result.current.handleKenEvent(ev("ready")));
    act(() => expect(hook.result.current.handleKenEvent(ev("ken_model_change"))).toBe(false));
    act(() =>
      hook.result.current.handleKenEvent(
        ev("ken_run_start", { ken: { ...identity, runId: "reconnected" } }),
      ),
    );
    expect(hook.result.current.captureKenRun()).toBeNull();
    expect(hook.result.current.kenRunning).toBe(false);
  });
  it("clears history stream references without retiring the authoritative active run", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "before history" }));
      hook.result.current.handleKenEvent(ev("ken_thinking_delta"));
      hook.result.current.clearKenStream();
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "after history" }));
    });
    expect(getItems()).toMatchObject([{ text: "before history" }, { text: "after history" }]);
    expect(hook.result.current.captureKenRun()).toEqual(identity);
    expect(hook.result.current.kenRunning).toBe(true);
    expect(hook.result.current.kenIsThinking).toBe(false);
    expect(hook.result.current.kenTokens).toBe(0);
  });
  it.each([
    "ken_run_start",
    "ken_text_delta",
    "ken_thinking_delta",
    "ken_tool_call_start",
    "ken_tool_call_update",
    "ken_tool_call_end",
    "ken_server_tool_call",
    "ken_turn_end",
    "ken_run_end",
    "ken_error",
  ])("consumes stale %s without disturbing the current run", (type) => {
    const { hook, getItems } = setup();
    act(() => hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "current" })));
    act(() =>
      expect(
        hook.result.current.handleKenEvent(
          ev(type, {
            ken: { ...identity, runId: "old" },
            text: "OLD",
            message: "OLD",
            usage: { outputTokens: 99 },
          }),
        ),
      ).toBe(true),
    );
    expect(getItems()).toMatchObject([{ text: "current" }]);
    expect(hook.result.current.kenRunning).toBe(true);
    expect(hook.result.current.kenTokens).toBe(0);
  });
  it("never learns authority from a start, model or draft and never revives a closed run", () => {
    const { hook, getItems } = setup();
    act(() => hook.result.current.hydrateKen(null));
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_model_change"));
      hook.result.current.handleKenEvent(ev("ken_run_start"));
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "unknown" }));
    });
    expect(getItems()).toEqual([]);
    act(() => hook.result.current.hydrateKen({ ...identity, activeRunId: "next" }));
    act(() =>
      hook.result.current.handleKenEvent(
        ev("ken_run_end", { ken: { ...identity, runId: "next" } }),
      ),
    );
    act(() => {
      hook.result.current.hydrateKen({ ...identity, activeRunId: "next" });
      hook.result.current.handleKenEvent(
        ev("ken_run_start", { ken: { ...identity, runId: "next" } }),
      );
    });
    expect(hook.result.current.kenRunning).toBe(false);
  });
  it("guards pending initial hydration after reset and isolates two panes", () => {
    const a = setup();
    const b = setup();
    const pending = a.hook.result.current.captureKenHydration();
    act(() => {
      a.hook.result.current.hydrateKen(
        { conversationId: "new", activationEpoch: "new", activeRunId: null },
        true,
      );
      pending({ ...identity, activeRunId: identity.runId });
      a.hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "old" }));
      b.hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "other pane" }));
    });
    expect(a.getItems()).toEqual([]);
    expect(a.hook.result.current.captureKenRun()).toBeNull();
    expect(b.getItems()).toMatchObject([{ text: "other pane" }]);
  });
  it("retains streaming across checkpoint extras but breaks it on history replacement", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "before" }));
      hook.result.current.handleKenEvent(
        ev("extras", { kenState: { ...identity, activeRunId: identity.runId } }),
      );
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: " retained" }));
    });
    expect(getItems()).toMatchObject([{ text: "before retained" }]);
    act(() => {
      hook.result.current.hydrateKen(
        { ...identity, activationEpoch: "replacement", activeRunId: "replacement-run" },
        true,
      );
      hook.result.current.handleKenEvent(
        ev("ken_text_delta", {
          ken: { ...identity, activationEpoch: "replacement", runId: "replacement-run" },
          text: "after",
        }),
      );
    });
    expect(getItems()).toMatchObject([{ text: "before retained" }, { text: "after" }]);
  });
  it.each([
    "ken_run_start",
    "ken_text_delta",
    "ken_thinking_delta",
    "ken_tool_call_start",
    "ken_tool_call_end",
    "ken_run_end",
    "ken_error",
  ])("consumes missing metadata on %s without changing mentor state", (type) => {
    const { hook, getItems } = setup();
    act(() => {
      expect(
        hook.result.current.handleKenEvent({ type, data: { text: "stale" } } as SidecarEvent),
      ).toBe(true);
    });
    expect(getItems()).toEqual([]);
    expect(hook.result.current.captureKenRun()).toEqual(identity);
    expect(hook.result.current.kenRunning).toBe(true);
  });
  it("ken_text_delta appends a single kind:'ken' item via setItems", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "hello" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "ken", text: "hello" });

    // A second delta appends to the SAME bubble, not a new item.
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: " world" }));
    });
    const after = getItems();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "ken", text: "hello world" });
  });

  it("ken_run_start flips kenRunning true and resets tokens", () => {
    const { hook } = setup();
    // Seed some tokens first so the reset is observable.
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_turn_end", { usage: { outputTokens: 42 } }));
    });
    expect(hook.result.current.kenTokens).toBe(42);

    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    expect(hook.result.current.kenRunning).toBe(true);
    expect(hook.result.current.kenTokens).toBe(0);
    expect(hook.result.current.kenRunStartTs).toBeTypeOf("number");
  });

  it.each(["ken_tool_call_start", "ken_server_tool_call"])(
    "handles current thinking, %s and end without joining pre-tool text",
    (type) => {
      const { hook, getItems } = setup();
      act(() => {
        hook.result.current.handleKenEvent(ev("ken_run_start"));
        hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "before tool" }));
        hook.result.current.handleKenEvent(ev("ken_thinking_delta"));
      });
      expect(hook.result.current.kenIsThinking).toBe(true);
      act(() => {
        hook.result.current.handleKenEvent(ev(type));
        hook.result.current.handleKenEvent(ev("ken_tool_call_update"));
        hook.result.current.handleKenEvent(ev("ken_tool_call_end"));
        hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "after tool" }));
      });
      expect(hook.result.current.kenIsThinking).toBe(false);
      expect(getItems()).toMatchObject([{ text: "before tool" }, { text: "after tool" }]);
      act(() => hook.result.current.handleKenEvent(ev("ken_run_end")));
      expect(hook.result.current.kenRunning).toBe(false);
      expect(hook.result.current.captureKenRun()).toBeNull();
      act(() => hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "late" })));
      expect(getItems()).toMatchObject([{ text: "before tool" }, { text: "after tool" }]);
    },
  );

  it("ken_turn_end accumulates outputTokens across turns", () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_turn_end", { usage: { outputTokens: 10 } }));
    });
    expect(hook.result.current.kenTokens).toBe(10);
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_turn_end", { usage: { outputTokens: 5 } }));
    });
    expect(hook.result.current.kenTokens).toBe(15);
  });

  it("ken_error with only a message (legacy shape) falls back to a flat text item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_error", { message: "boom" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "error" });
    expect((items[0] as { text: string }).text).toContain("boom");
    expect(hook.result.current.kenRunning).toBe(false);
  });

  it("ken_error with a structured payload prefixes the headline with Supah", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    act(() => {
      hook.result.current.handleKenEvent(
        ev("ken_error", {
          headline: "Anthropic usage limit reached.",
          message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
          guidance: "Try again once it's back. Your conversation is preserved.",
        }),
      );
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "error",
      headline: "Supah: Anthropic usage limit reached.",
      message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
      guidance: "Try again once it's back. Your conversation is preserved.",
    });
    expect(hook.result.current.kenRunning).toBe(false);
  });

  it("returns true for ken events and false for a non-ken event", () => {
    const { hook, getItems } = setup();
    let kenHandled = false;
    let buildHandled = true;
    act(() => {
      kenHandled = hook.result.current.handleKenEvent(ev("ken_run_start"));
      buildHandled = hook.result.current.handleKenEvent(ev("text_delta", { text: "build" }));
    });
    expect(kenHandled).toBe(true);
    expect(buildHandled).toBe(false);
    // A non-ken event must NOT have touched the transcript.
    expect(getItems()).toHaveLength(0);
  });
});
