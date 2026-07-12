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
    const createArgs = mocks.invoke.mock.calls.find(
      ([command]) => command === "terminal_create",
    )?.[1];
    expect(Object.keys(createArgs as object)).toEqual(["paneId", "cols", "rows", "onEvent"]);
    expect(createArgs).not.toHaveProperty("cwd");
    expect(createArgs).not.toHaveProperty("command");
    expect(createArgs).not.toHaveProperty("history");
    expect(createArgs).not.toHaveProperty("output");
    expect(createArgs).not.toHaveProperty("terminalId");
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "terminal_input",
      expect.anything(),
      expect.anything(),
    );
  });

  it("forwards the logical pane ID through input, resize, and close", async () => {
    const terminal = createTerminal("primary", 80, 24, vi.fn());
    const input = new Uint8Array([0, 0xff, 0x1b]);

    await terminal.input(input);
    await terminal.resize(100, 30);
    await terminal.close();

    expect(mocks.invoke).toHaveBeenCalledWith("terminal_input", input, {
      headers: {
        "Tauri-Terminal-Pane-Id": "primary",
        "Tauri-Terminal-Id": "terminal-1",
      },
    });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_resize", {
      paneId: "primary",
      terminalId: "terminal-1",
      cols: 100,
      rows: 30,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", {
      paneId: "primary",
      terminalId: "terminal-1",
    });
  });

  it("filters control events for another pane or terminal runtime", async () => {
    const events: TerminalEvent[] = [];
    const terminal = createTerminal("primary", 80, 24, (event) => events.push(event));
    await terminal.ready;

    mocks.channel?.onmessage({
      type: "exit",
      terminalId: "terminal-1",
      paneId: "secondary",
      exitCode: 0,
    });
    mocks.channel?.onmessage({
      type: "exit",
      terminalId: "stale-terminal",
      paneId: "primary",
      exitCode: 0,
    });
    mocks.channel?.onmessage({
      type: "exit",
      terminalId: "terminal-1",
      paneId: "primary",
      exitCode: 0,
    });

    expect(events).toEqual([
      { type: "exit", terminalId: "terminal-1", paneId: "primary", exitCode: 0 },
    ]);
  });

  it("keeps concurrent terminal event channels isolated", async () => {
    mocks.invoke.mockImplementation(async (command: string, args?: { paneId?: string }) => {
      if (command !== "terminal_create") return undefined;
      const paneId = args?.paneId ?? "primary";
      return { ...info, paneId, terminalId: `terminal-${paneId}` };
    });
    const primaryEvents: TerminalEvent[] = [];
    const primary = createTerminal("primary", 80, 24, (event) => primaryEvents.push(event));
    const primaryChannel = mocks.channel;
    const secondaryEvents: TerminalEvent[] = [];
    const secondary = createTerminal("secondary", 80, 24, (event) => secondaryEvents.push(event));
    const secondaryChannel = mocks.channel;
    await Promise.all([primary.ready, secondary.ready]);

    primaryChannel?.onmessage({
      type: "error",
      terminalId: "terminal-primary",
      paneId: "primary",
      message: "primary only",
    });
    secondaryChannel?.onmessage({
      type: "error",
      terminalId: "terminal-secondary",
      paneId: "secondary",
      message: "secondary only",
    });
    primaryChannel?.onmessage({
      type: "exit",
      terminalId: "terminal-secondary",
      paneId: "secondary",
      exitCode: 0,
    });

    expect(primaryEvents).toEqual([
      {
        type: "error",
        terminalId: "terminal-primary",
        paneId: "primary",
        message: "primary only",
      },
    ]);
    expect(secondaryEvents).toEqual([
      {
        type: "error",
        terminalId: "terminal-secondary",
        paneId: "secondary",
        message: "secondary only",
      },
    ]);
  });
});
