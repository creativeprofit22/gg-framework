import { describe, it, expect } from "vitest";

// ── Reproduction of the stall-retry text duplication bug ────────────────
//
// When the agent-loop's stream stalls mid-message, it yields a `retry` event
// and starts a fresh LLM call (agent-loop.ts ~line 467-488). useAgentLoop.ts
// handles `retry` by updating phase/UI state only — it does NOT clear the
// accumulated text buffer (textVisibleRef). So the aborted stream's partial
// text stays in the buffer, and when the retry emits its text_delta events
// (starting from scratch, because the provider stream restarts), those are
// appended to the already-populated buffer — producing the doubled "Now I'll
// work on this.. Now I'll work on this.." symptom.
//
// These tests model only the refs that accumulate text, simulating the event
// sequence that `useAgentLoop`'s `for await` loop processes.

type Event =
  { type: "text_delta"; text: string } | { type: "retry"; silent: boolean } | { type: "turn_end" };

interface Buffers {
  textVisible: string;
  streamingText: string;
}

// Mirrors the CURRENT handler in useAgentLoop.ts — retry does not reset text.
function handleEventCurrent(buf: Buffers, ev: Event): Buffers {
  if (ev.type === "text_delta") {
    return {
      ...buf,
      textVisible: buf.textVisible + ev.text,
      streamingText: buf.textVisible + ev.text,
    };
  }
  if (ev.type === "retry") {
    // current behaviour: only updates UI phase, leaves text buffers intact
    return buf;
  }
  if (ev.type === "turn_end") {
    // commit + reset
    return { textVisible: "", streamingText: "" };
  }
  return buf;
}

// Proposed fix: retry also clears the stream-accumulation buffers, since the
// provider stream restarts from scratch on retry.
function handleEventFixed(buf: Buffers, ev: Event): Buffers {
  if (ev.type === "text_delta") {
    return {
      ...buf,
      textVisible: buf.textVisible + ev.text,
      streamingText: buf.textVisible + ev.text,
    };
  }
  if (ev.type === "retry") {
    return { textVisible: "", streamingText: "" };
  }
  if (ev.type === "turn_end") {
    return { textVisible: "", streamingText: "" };
  }
  return buf;
}

// Simulate a stall in the middle of a message:
// Attempt 1 emits the first few deltas, then the stream stalls.
// agent-loop yields `retry`, starts fresh call.
// Attempt 2 emits the full message from scratch (the model regenerates).
function stallRetrySequence(): Event[] {
  return [
    { type: "text_delta", text: "Now I'll work on this.." },
    // stream stalls here — agent-loop yields retry
    { type: "retry", silent: true },
    // new stream begins and regenerates similar opening text
    { type: "text_delta", text: "Now I'll work on this.." },
    { type: "text_delta", text: " Here is the rest of the response." },
    { type: "turn_end" },
  ];
}

function run(handler: (b: Buffers, e: Event) => Buffers, events: Event[]): Buffers[] {
  const frames: Buffers[] = [];
  let buf: Buffers = { textVisible: "", streamingText: "" };
  for (const ev of events) {
    buf = handler(buf, ev);
    frames.push({ ...buf });
  }
  return frames;
}

describe("stall-retry text duplication", () => {
  it("REPRODUCE: current handler produces doubled text visible mid-stream", () => {
    const frames = run(handleEventCurrent, stallRetrySequence());

    // After the retry + first text_delta of the new attempt, the UI shows
    // the original partial text concatenated with the retry's opening —
    // exactly the user-reported "Now I'll work on this..Now I'll work on this.." flash.
    const afterFirstRetryDelta = frames[2];
    expect(afterFirstRetryDelta.streamingText).toBe(
      "Now I'll work on this..Now I'll work on this..",
    );
  });

  it("FIXED handler clears buffers on retry so the retry stream starts clean", () => {
    const frames = run(handleEventFixed, stallRetrySequence());

    // Same frame index, but now the partial text was cleared when the retry
    // event fired, so only the retry's own first delta is visible.
    const afterFirstRetryDelta = frames[2];
    expect(afterFirstRetryDelta.streamingText).toBe("Now I'll work on this..");

    // Final committed text is the full retry response, with no duplication.
    const final = frames[frames.length - 1];
    expect(final.streamingText).toBe("");
  });

  it("FIXED handler is a no-op on retry when the stream hadn't emitted text yet", () => {
    // Overloaded errors often retry before any text_delta has arrived.
    // The fix must not misbehave in that case.
    const events: Event[] = [
      { type: "retry", silent: false },
      { type: "text_delta", text: "Hello world" },
      { type: "turn_end" },
    ];
    const frames = run(handleEventFixed, events);
    expect(frames[1].streamingText).toBe("Hello world");
  });
});
