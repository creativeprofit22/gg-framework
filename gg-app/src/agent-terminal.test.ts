import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent, TerminalInfo } from "./agent";

const mocks = vi.hoisted(() => {
  const invoke = vi.fn();
  let channel: { onmessage: (event: TerminalEvent) => void } | undefined;
  return {
    invoke,
    get channel() {
      return channel;
    },
    set channel(value) {
      channel = value;
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: (event: TerminalEvent) => void = () => {};
    constructor() {
      mocks.channel = this;
    }
  },
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(),
    setTitle: vi.fn(async () => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(async () => {}),
  info: vi.fn(async () => {}),
}));

import { createTerminal } from "./agent";

const info: TerminalInfo = {
  terminalId: "terminal-1",
  paneId: "primary",
  cwd: "C:/project",
  shell: "cmd.exe",
  cols: 80,
  rows: 24,
};

describe("terminal IPC", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.channel = undefined;
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "terminal_create" ? info : undefined,
    );
  });

  it("streams raw output and control events over one ordered channel", async () => {
    const events: TerminalEvent[] = [];
    const terminal = createTerminal("primary", 80, 24, (event) => events.push(event));
    await terminal.ready;
    const output = new Uint8Array([0, 0xff, 0x1b]).buffer;
    const exit: TerminalEvent = {
      type: "exit",
      terminalId: "terminal-1",
      paneId: "primary",
      exitCode: 0,
    };

    mocks.channel?.onmessage(output);
    mocks.channel?.onmessage(exit);

    expect(events).toEqual([output, exit]);
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_create", {
      paneId: "primary",
      cols: 80,
      rows: 24,
      onEvent: mocks.channel,
    });
  });

  it("sends input bytes raw with owner identifiers in headers", async () => {
    const terminal = createTerminal("primary", 80, 24, vi.fn());
    const input = new Uint8Array([0, 0xff, 0x1b]);

    await terminal.input(input);

    expect(mocks.invoke).toHaveBeenLastCalledWith("terminal_input", input, {
      headers: {
        "Tauri-Terminal-Pane-Id": "primary",
        "Tauri-Terminal-Id": "terminal-1",
      },
    });
  });
});
