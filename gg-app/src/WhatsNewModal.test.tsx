// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import { WHATS_NEW_STORAGE_KEY } from "./whats-new";
import { WhatsNewModal } from "./WhatsNewModal";

const mocks = vi.hoisted(() => ({
  openWhatsNewWindow: vi.fn().mockResolvedValue(undefined),
  localPatched: true,
  logError: vi.fn(),
}));

vi.mock("./agent", () => ({
  windowLabel: "main",
  openWhatsNewWindow: mocks.openWhatsNewWindow,
}));
vi.mock("./build-info", () => ({ appBuildInfo: { localPatched: mocks.localPatched } }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: mocks.logError }));

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  mocks.localPatched = true;
  mocks.openWhatsNewWindow.mockReset().mockResolvedValue(undefined);
  mocks.logError.mockReset();
});

describe("WhatsNewModal", () => {
  it("does not open on first install", () => {
    render(<WhatsNewModal />);

    expect(mocks.openWhatsNewWindow).not.toHaveBeenCalled();
  });

  it("does not open when every feed head is seen", () => {
    localStorage.setItem(
      WHATS_NEW_STORAGE_KEY,
      JSON.stringify({ local: LOCAL_CHANGELOG[0].id, upstream: CHANGELOG[0].version }),
    );

    render(<WhatsNewModal />);

    expect(mocks.openWhatsNewWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["Local Fork", { local: LOCAL_CHANGELOG[1].id, upstream: CHANGELOG[0].version }],
    ["Upstream", { local: LOCAL_CHANGELOG[0].id, upstream: CHANGELOG[1].version }],
  ])("opens once for an unseen %s head", (_source, seen) => {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify(seen));

    render(<WhatsNewModal />);

    expect(mocks.openWhatsNewWindow).toHaveBeenCalledOnce();
  });

  it("does not mark feeds seen when the native open request fails", async () => {
    const seen = { local: LOCAL_CHANGELOG[1].id, upstream: CHANGELOG[1].version };
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify(seen));
    mocks.openWhatsNewWindow.mockRejectedValueOnce(new Error("native unavailable"));

    render(<WhatsNewModal />);
    await waitFor(() => expect(mocks.logError).toHaveBeenCalledOnce());

    expect(JSON.parse(localStorage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual(seen);
  });
});
