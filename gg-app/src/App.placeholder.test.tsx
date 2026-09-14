// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentPane as AgentPaneComponent } from "./AgentPane";

let AgentPane: typeof AgentPaneComponent;

beforeAll(async () => {
  mockWindows("main");
  mockIPC(() => new Promise(() => {}));
  AgentPane = (await import("./AgentPane")).AgentPane;
});

beforeEach(() => {
  vi.useFakeTimers();
  mockWindows("main");
  // Keep native restoration pending: exercise the actual shell, without a daemon.
  mockIPC(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("placeholder work outside the composer", () => {
  it.each([true, false])("does not animate while restoring (focused=%s)", (focused) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    const interval = vi.spyOn(window, "setInterval");
    const view = render(<AgentPane />);
    expect(view.getByText("Restoring workspace…")).toBeTruthy();

    act(() => vi.advanceTimersByTime(12_500));
    const placeholderTimers = interval.mock.calls.filter(
      ([, delay]) => delay === 12_000 || delay === 24,
    );
    expect(placeholderTimers).toHaveLength(0);
  });
});
