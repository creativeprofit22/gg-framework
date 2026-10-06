// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatErrorNotice } from "./ChatErrorNotice";
import { ERROR_CRITTER_BLINKS, assignErrorCritters } from "./ErrorCritter";
import { CRITTERS } from "./critter-sprites";
import {
  activeChatErrorId,
  chatErrorCopy,
  chatErrorTone,
  readChatError,
  type ChatErrorData,
  type ChatErrorItem,
} from "./chat-error";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const limit: ChatErrorData = {
  reason: "usage_limit",
  headline: "ChatGPT usage limit reached",
  guidance: "Wait for the reset, or use another provider.",
  message: "Provider diagnostic",
  scope: "error",
};

describe("error critters", () => {
  it.each(CRITTERS.map((c) => [c.id, c] as const))(
    "%s: closes its eyes over its eyes",
    (_id, c) => {
      const blink = ERROR_CRITTER_BLINKS[c.id];
      if (!blink) throw new Error(`no blink for ${c.id}`);
      expect(c.palette[blink.lid]).toBeTruthy();
      for (const [x, y, width, height] of blink.eyes) {
        const cells = c.rows.slice(y, y + height).flatMap((row) => [...row.slice(x, x + width)]);
        expect(cells).toHaveLength(width * height);
        expect(cells).not.toContain(".");
        expect(cells.some((cell) => "WKCY".includes(cell))).toBe(true);
      }
    },
  );

  // The same error repeated, as in a retry loop: identical copy, distinct times.
  const errors = (count: number, firstId: number): ChatErrorItem[] =>
    Array.from({ length: count }, (_, i) => ({
      ...limit,
      kind: "error",
      id: firstId + i * 2,
      occurredAt: 1_800_000_000_000 + i * 60_000,
    }));
  const picks = (items: readonly { id: number; kind: string }[]): string[] => {
    const assigned = assignErrorCritters(items);
    return items.flatMap((item) => assigned.get(item.id) ?? []);
  };

  it("never repeats a critter within four errors in a row", () => {
    const ids = picks(errors(40, 1));
    expect(ids).toHaveLength(40);
    ids.forEach((id, i) => expect(ids.slice(Math.max(0, i - 3), i)).not.toContain(id));
    expect(new Set(ids).size).toBeGreaterThan(8);
  });

  it("keeps each error's critter after reopening, when the row ids change", () => {
    const live = errors(6, 1);
    const reopened = errors(6, 500).map((error) => ({ ...error, historical: true }));
    const withOtherRows = reopened.flatMap((error) => [{ kind: "user", id: error.id - 1 }, error]);
    expect(picks(withOtherRows)).toEqual(picks(live));
  });

  it("keeps earlier errors' critters when a new error arrives", () => {
    const all = errors(5, 1);
    expect(picks(all).slice(0, 4)).toEqual(picks(all.slice(0, 4)));
  });

  it("renders the assigned critter", () => {
    const { container } = render(<ChatErrorNotice critterId="crab" error={limit} active />);
    expect(container.querySelector(".chat-error-critter")?.getAttribute("data-critter")).toBe(
      "crab",
    );
  });
});

describe("compact chat errors", () => {
  it("shows two concise lines in amber, with details hidden and one model action", () => {
    const { container } = render(
      <ChatErrorNotice
        critterId="cat"
        error={limit}
        active
        modelPicker={<button>Switch provider</button>}
      />,
    );
    expect(screen.getByText(limit.headline ?? "")).toBeTruthy();
    expect(container.querySelector(".chat-error-warning")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Switch provider" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show error details" });
    expect(toggle.textContent).toBe("Details");
    expect(
      toggle.closest(".chat-error-heading")?.querySelector(".chat-error-headline")?.textContent,
    ).toBe(limit.headline);
    expect(container.querySelector<HTMLElement>(".chat-error-details")?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(container.querySelector<HTMLElement>(".chat-error-details")?.hidden).toBe(false);
    expect(screen.getByText("Provider diagnostic")).toBeTruthy();
  });

  it("dissolves details out before hiding them and keeps closing content inert", () => {
    vi.useFakeTimers();
    const onContentGrow = vi.fn();
    const { container, unmount } = render(
      <ChatErrorNotice critterId="cat" error={limit} active onContentGrow={onContentGrow} />,
    );
    const toggle = screen.getByRole("button", { name: "Show error details" });
    const details = container.querySelector<HTMLElement>(".chat-error-details");
    fireEvent.click(toggle);
    expect(details?.classList.contains("dissolve-in")).toBe(true);
    expect(details?.getAttribute("aria-hidden")).toBe("false");
    expect(onContentGrow).toHaveBeenCalledOnce();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details?.hidden).toBe(false);
    expect(details?.classList.contains("leaving")).toBe(true);
    expect(details?.hasAttribute("inert")).toBe(true);
    expect(details?.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(339));
    expect(details?.hidden).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(details?.hidden).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can reopen details during their exit without a stale timer hiding them", () => {
    vi.useFakeTimers();
    const { container } = render(<ChatErrorNotice critterId="cat" error={limit} active />);
    const toggle = screen.getByRole("button", { name: "Show error details" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(toggle);
    act(() => vi.advanceTimersByTime(340));
    const details = container.querySelector<HTMLElement>(".chat-error-details");
    expect(details?.hidden).toBe(false);
    expect(details?.hasAttribute("inert")).toBe(false);
    expect(details?.classList.contains("leaving")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders failures red and never executes diagnostic markup", () => {
    const { container } = render(
      <ChatErrorNotice
        critterId="cat"
        error={{
          reason: "provider",
          headline: "Request failed",
          guidance: "Check details",
          message: '<script>throw new Error("not code")</script>',
        }}
        active
      />,
    );
    expect(container.querySelector(".chat-error-error")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>/)).toBeTruthy();
  });

  it("pauses animation without adding a control to the two-line row", () => {
    const { container } = render(<ChatErrorNotice critterId="cat" error={limit} active />);
    expect(container.querySelector(".chat-error-blink.is-animated")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show error details" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause critter animation" }));
    expect(container.querySelector(".chat-error-blink.is-animated")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Resume critter animation" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps restored errors muted and still, without active actions or stale reset advice", () => {
    const { container } = render(
      <ChatErrorNotice
        critterId="cat"
        error={{ ...limit, historical: true }}
        active={false}
        modelPicker={<button>Switch provider</button>}
      />,
    );
    expect(container.querySelector(".chat-error-history")).not.toBeNull();
    expect(container.querySelector(".is-animated")).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch provider" })).toBeNull();
    expect(screen.getByText("Earlier: ChatGPT usage limit reached")).toBeTruthy();
    expect(
      screen.queryByText("Wait for the reset, or use another provider.")?.closest("[hidden]"),
    ).toBeTruthy();
  });

  it("changes guidance at reset time without promising recovery, then cleans up the timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const { unmount } = render(
      <ChatErrorNotice critterId="cat" error={{ ...limit, resetsAt: 1_800_000_001 }} active />,
    );
    act(() => {
      vi.advanceTimersByTime(1_002);
    });
    expect(
      screen.getByText("The reset time has passed. Check usage before trying again."),
    ).toBeTruthy();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains metadata across each scope and rejects malformed values", () => {
    for (const scope of ["error", "ken_error", "autopilot_error"]) {
      const parsed = readChatError(
        { ...limit, resetsAt: 1_800_000_000, occurredAt: 1_799_000_000_000, statusCode: 429 },
        scope,
      );
      expect(parsed.scope).toBe(scope);
      expect(parsed.resetsAt).toBe(1_800_000_000);
      expect(chatErrorCopy(parsed, true, 1_800_000_000_001).guidance).toContain(
        "reset time has passed",
      );
    }
    const invalid = readChatError({
      reason: "run_command",
      resetsAt: Infinity,
      statusCode: "429",
      headline: [],
    });
    expect(invalid.reason).toBeUndefined();
    expect(invalid.resetsAt).toBeUndefined();
    expect(invalid.headline).toBeUndefined();
  });

  it("distinguishes warnings, failures and history independently of provider text", () => {
    expect(chatErrorTone({ reason: "billing" }, true)).toBe("error");
    expect(chatErrorTone({ reason: "rate_limit" }, true)).toBe("warning");
    expect(chatErrorTone({ reason: "provider" }, false)).toBe("history");
    expect(
      chatErrorCopy({ headline: "Unsupported model", guidance: "Wait for usage" }, true, 0)
        .headline,
    ).toBe("Something went wrong");
  });

  it("retires errors after a new message, without treating them as resolved", () => {
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "info" },
      ]),
    ).toBe(1);
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "user" },
      ]),
    ).toBeNull();
    expect(activeChatErrorId([{ id: 1, kind: "error", historical: true }])).toBeNull();
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "ken" },
      ]),
    ).toBe(1);
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "assistant" },
      ]),
    ).toBe(1);
  });
});
