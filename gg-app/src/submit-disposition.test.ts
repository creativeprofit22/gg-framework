import { describe, expect, it } from "vitest";
import { submitDisposition } from "./submit-disposition";

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
