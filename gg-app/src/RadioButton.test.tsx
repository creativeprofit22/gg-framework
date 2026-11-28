// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RadioState } from "./agent";

const agentMocks = vi.hoisted(() => ({
  getRadioState: vi.fn(),
  setRadio: vi.fn(),
  setRadioVolume: vi.fn(),
}));

vi.mock("./agent", () => ({
  getRadioState: agentMocks.getRadioState,
  setRadio: agentMocks.setRadio,
  setRadioVolume: agentMocks.setRadioVolume,
}));

import { RadioButton } from "./RadioButton";

const loaded: RadioState = {
  current: null,
  volume: 70,
  stations: [
    { id: "lofi", name: "Lo-fi", description: "Fixture station", url: "https://example.test/lofi" },
    {
      id: "classical",
      name: "Classical",
      description: "Second station",
      url: "https://example.test/classical",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openRadio() {
  fireEvent.click(screen.getByRole("button", { name: "Internet radio" }));
  return screen.getByRole("dialog", { name: "Internet Radio" });
}

describe("RadioButton", () => {
  beforeEach(() => {
    agentMocks.getRadioState.mockReset();
    agentMocks.setRadio.mockReset();
    agentMocks.setRadioVolume.mockReset();
  });
  afterEach(cleanup);

  it("names the titlebar button and associates the Volume label", async () => {
    agentMocks.getRadioState.mockResolvedValue(loaded);
    render(<RadioButton />);
    openRadio();
    expect(await screen.findByRole("slider", { name: "Volume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Station" })).toBeTruthy();
  });

  it("moves from loading to ready and enables Play", async () => {
    const read = deferred<RadioState>();
    agentMocks.getRadioState.mockReturnValue(read.promise);
    render(<RadioButton />);
    openRadio();
    expect(screen.getAllByText("Loading stations\u2026").length).toBeGreaterThan(0);
    const play = screen.getByRole("button", { name: "Play" }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    await act(async () => read.resolve(loaded));
    await waitFor(() => expect(play.disabled).toBe(false));
    expect(screen.getByText("Lo-fi")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed read with Retry instead of loading forever", async () => {
    agentMocks.getRadioState.mockRejectedValue(new Error("daemon offline"));
    render(<RadioButton />);
    openRadio();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn\u2019t load radio stations.");
    expect(screen.queryByText("Loading stations\u2026")).toBeNull();
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);

    agentMocks.getRadioState.mockResolvedValue(loaded);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes an empty station list and retries it", async () => {
    agentMocks.getRadioState.mockResolvedValue({ ...loaded, stations: [] });
    render(<RadioButton />);
    openRadio();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No radio stations are available right now.",
    );
    expect(screen.getByText("No stations available")).toBeTruthy();

    agentMocks.getRadioState.mockResolvedValue(loaded);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(agentMocks.getRadioState).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale mount read that resolves after the fresher open read", async () => {
    const mountRead = deferred<RadioState>();
    const openRead = deferred<RadioState>();
    agentMocks.getRadioState
      .mockReturnValueOnce(mountRead.promise)
      .mockReturnValueOnce(openRead.promise);
    render(<RadioButton />);
    openRadio();
    await act(async () => openRead.resolve({ ...loaded, current: "classical", volume: 40 }));
    await act(async () => mountRead.reject(new Error("stale failure")));
    await act(async () => mountRead.resolve(loaded));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("restores and explains the volume when saving it fails", async () => {
    agentMocks.getRadioState.mockResolvedValue(loaded);
    agentMocks.setRadioVolume.mockRejectedValue(new Error("write failed"));
    render(<RadioButton />);
    openRadio();
    const slider = (await screen.findByRole("slider", { name: "Volume" })) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe("70"));
    fireEvent.change(slider, { target: { value: "30" } });
    expect(screen.getByText("30%")).toBeTruthy();
    fireEvent.keyUp(slider);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't change the volume; it stays at 70%.");
    expect(alert.textContent).toContain("write failed");
    expect(slider.value).toBe("70");
    expect(agentMocks.setRadioVolume).toHaveBeenCalledWith(30);
  });
});
