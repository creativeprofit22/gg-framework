import { describe, expect, it } from "vitest";
import {
  showsQueuedBubble,
  submitDisposition,
  withoutSupersedingMessage,
} from "./submit-disposition";

describe("submitDisposition", () => {
  it("queues a folder picked while the agent is running instead of dropping it", () => {
    // The regression: `/add-dir <path>` chosen from the native picker mid-run
    // used to be discarded silently — dialog opens, folder chosen, nothing
    // happens. Typed input always queued as steering; now this does too.
    expect(submitDisposition("/add-dir /tmp/sdk", true, true)).toBe("queue");
    expect(submitDisposition("/remove-dir /tmp/sdk", true, true)).toBe("queue");
  });

  it("sends immediately when no run is in flight", () => {
    expect(submitDisposition("/add-dir /tmp/sdk", true, false)).toBe("send");
    expect(submitDisposition("/commit", true, false)).toBe("send");
  });

  it("ignores empty or whitespace-only text", () => {
    expect(submitDisposition("", true, false)).toBe("ignore");
    expect(submitDisposition("   \n\t ", true, false)).toBe("ignore");
    // Still ignored mid-run — queueing nothing would push an empty bubble.
    expect(submitDisposition("   ", true, true)).toBe("ignore");
  });

  it("ignores everything until the sidecar is ready", () => {
    expect(submitDisposition("/add-dir /tmp/sdk", false, false)).toBe("ignore");
    expect(submitDisposition("/add-dir /tmp/sdk", false, true)).toBe("ignore");
  });
});

describe("showsQueuedBubble", () => {
  it("skips the queued look for a prompt that supersedes an open question", () => {
    // The regression: answering a question by typing something else made the
    // bubble render dim + dashed + "queued", then promote a beat later, because
    // releasing the parked call hands it to the agent almost instantly.
    expect(showsQueuedBubble("queue", true)).toBe(false);
  });

  it("still marks an ordinary mid-run send as queued", () => {
    // It really is waiting behind the current tool call, and the pill is the
    // only thing that says so.
    expect(showsQueuedBubble("queue", false)).toBe(true);
  });

  it("never marks a fresh run as queued", () => {
    expect(showsQueuedBubble("send", false)).toBe(false);
    expect(showsQueuedBubble("send", true)).toBe(false);
  });
});

describe("withoutSupersedingMessage", () => {
  const msg = (id: string, text: string) => ({ id, text });

  it("hides the superseding message so the strip never opens for it", () => {
    // The regression: the strip is a sibling of the transcript, so it opening
    // (260ms) and shutting again (220ms) shoved the whole thread up and back
    // down within half a second.
    expect(
      withoutSupersedingMessage([msg("q1", "do it differently")], "do it differently"),
    ).toEqual([]);
  });

  it("keeps messages the user genuinely queued", () => {
    const messages = [msg("q1", "check the logs"), msg("q2", "do it differently")];
    expect(withoutSupersedingMessage(messages, "do it differently")).toEqual([
      msg("q1", "check the logs"),
    ]);
    expect(withoutSupersedingMessage(messages, null)).toBe(messages);
  });

  it("drops only one copy, so an identical queued message stays cancellable", () => {
    const messages = [msg("q1", "again"), msg("q2", "again")];
    expect(withoutSupersedingMessage(messages, "again")).toEqual([msg("q2", "again")]);
  });

  it("leaves the list untouched once the agent has consumed it", () => {
    const messages = [msg("q1", "check the logs")];
    expect(withoutSupersedingMessage(messages, "do it differently")).toBe(messages);
  });
});
