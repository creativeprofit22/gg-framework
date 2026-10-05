// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentState,
  SidecarEvent,
  DroppedPathInfo,
  Attachment,
  PaneAgentClient,
  PaneSessionTarget,
} from "./agent";
import type { PendingAttachment } from "./attachments";
import type { PaneInputActions } from "./AgentPane";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { AgentPane } = await import("./AgentPane");
const { fakePaneClient } = await import("./test-support/fake-pane-client");
const target: PaneSessionTarget = {
  mode: "code",
  cwd: "/workspaces/attachments",
  sessionPath: null,
};
// Fork: each chat pane is AgentPane driven by its own client; Ken prompts go through it.
let currentPane: PaneAgentClient | undefined;
let inputActions: PaneInputActions | null = null;
// Fork composer button titles: "Send message" / "Stop response" (upstream: "Send" / "Stop the run").
const SEND = "Send message";
const STOP = "Stop response";
const attachments = await import("./attachments");
const agent = await import("./agent");
const notifications = await import("./toast");
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const image: PendingAttachment = {
  kind: "image",
  name: "screenshot.png",
  mediaType: "image/png",
  data: "c2NyZWVuc2hvdA==",
  id: 17,
  previewUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.spyOn(notifications, "toast").mockReturnValue(1);
});
afterEach(() => {
  cleanup();
  clearMocks();
  currentPane = undefined;
  inputActions = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

async function setup(running = false): Promise<{
  input: HTMLTextAreaElement;
  sends: ReturnType<typeof vi.fn>;
  emit: (event: SidecarEvent) => void;
}> {
  const state: AgentState = {
    accountId: null,
    openAICodexContextProfileEligibility: { canChange: true },
    openAICodexContextProfile: "stable",
    openAICodexFast: false,
    contextTokens: 0,
    contextWindow: 200_000,
    cwd: "/workspaces/attachments",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running,
  };
  mockWindows("main");
  mockIPC((command) => (command === "plugin:log|log" ? null : new Promise(() => {})));
  const { pane, sends, emit } = fakePaneClient(state);
  currentPane = pane;
  render(
    <AgentPane
      client={pane}
      target={target}
      registerInput={(_paneId, actions) => {
        inputActions = actions;
      }}
    />,
  );
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox");
  await waitFor(() => expect(document.querySelector(".footer-skeleton")).toBeNull());
  return { input, sends, emit };
}
function paste(input: HTMLTextAreaElement): void {
  fireEvent.paste(input, {
    clipboardData: { files: [new File(["screenshot"], "screenshot.png", { type: "image/png" })] },
  });
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("composer attachments", () => {
  it("reads and sends a pasted screenshot on the first click", async () => {
    const { input, sends } = await setup();
    paste(input);
    await screen.findByRole("button", { name: "Remove screenshot.png" });
    fireEvent.click(screen.getByTitle(SEND));
    await waitFor(() =>
      expect(sends).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [attachments.toWire(image)] }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove screenshot.png" })).toBeNull(),
    );
  });

  it.each([false, true])(
    "blocks clicks and Enter until screenshot reads finish (running=%s)",
    async (running) => {
      const pending = deferred<PendingAttachment>();
      vi.spyOn(attachments, "fileToPending").mockReturnValue(pending.promise);
      const { input, sends } = await setup(running);
      fireEvent.change(input, { target: { value: "Check this screenshot" } });
      paste(input);
      if (!running) {
        const loading = screen.getByTitle<HTMLButtonElement>("Loading attachments…");
        expect(loading.disabled).toBe(true);
        fireEvent.click(loading);
      } else {
        expect(screen.getByTitle<HTMLButtonElement>(STOP).disabled).toBe(false);
      }
      fireEvent.keyDown(input, { key: "Enter" });
      expect(sends).not.toHaveBeenCalled();
      expect(input.value).toBe("Check this screenshot");
      expect(notifications.toast).toHaveBeenCalledWith(
        "Attachments are still loading. Please wait.",
      );
      await act(async () => {
        pending.resolve(image);
        await pending.promise;
      });
      if (running) fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(screen.getByTitle(SEND));
      await waitFor(() =>
        expect(sends).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            text: "Check this screenshot",
            attachments: [attachments.toWire(image)],
          }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Remove screenshot.png" })).toBeNull(),
      );
    },
  );

  it("blocks sending throughout native drop lookup and reading", async () => {
    const lookup = deferred<DroppedPathInfo[]>();
    const read = deferred<Attachment | null>();
    vi.spyOn(agent, "getDroppedPathInfo").mockReturnValue(lookup.promise);
    vi.spyOn(agent, "readDroppedFileAttachment").mockReturnValue(read.promise);
    let drop: (() => void) | undefined;
    const { input, sends } = await setup();
    // Fork: WorkspaceShell owns the webview drop listener and forwards paths to the pane.
    if (inputActions) drop = () => inputActions?.handleNativeDrop(["/tmp/screenshot.png"]);
    fireEvent.change(input, { target: { value: "Check this screenshot" } });
    expect(drop).toBeDefined();
    act(() => drop?.());
    expect(screen.getByTitle<HTMLButtonElement>("Loading attachments…").disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sends).not.toHaveBeenCalled();
    await act(async () => {
      lookup.resolve([{ path: "/tmp/screenshot.png", isDir: false }]);
      await lookup.promise;
    });
    expect(agent.readDroppedFileAttachment).toHaveBeenCalledWith("/tmp/screenshot.png");
    expect(screen.getByTitle<HTMLButtonElement>("Loading attachments…").disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sends).not.toHaveBeenCalled();
    await act(async () => {
      read.resolve(attachments.toWire(image));
      await read.promise;
    });
    fireEvent.click(screen.getByTitle(SEND));
    await waitFor(() =>
      expect(sends).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ attachments: [attachments.toWire(image)] }),
      ),
    );
  });

  it("waits for overlapping pastes, not just the first completed read", async () => {
    const first = deferred<PendingAttachment>();
    const second = deferred<PendingAttachment>();
    vi.spyOn(attachments, "fileToPending")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { input, sends } = await setup();
    paste(input);
    paste(input);
    await act(async () => {
      first.resolve(image);
      await first.promise;
    });
    expect(screen.getByTitle<HTMLButtonElement>("Loading attachments…").disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sends).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve({ ...image, id: 18, name: "second.png" });
      await second.promise;
    });
    fireEvent.click(screen.getByTitle(SEND));
    await waitFor(() =>
      expect(sends).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          attachments: [
            attachments.toWire(image),
            { ...attachments.toWire(image), name: "second.png" },
          ],
        }),
      ),
    );
  });

  it("does not carry an unfinished attachment into a new session", async () => {
    const old = deferred<PendingAttachment>();
    const current = deferred<PendingAttachment>();
    vi.spyOn(attachments, "fileToPending")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { input, sends, emit } = await setup();
    paste(input);
    act(() => emit({ type: "session_reset", data: {} }));
    paste(input);
    await act(async () => {
      old.resolve(image);
      await old.promise;
    });
    expect(screen.queryByRole("button", { name: "Remove screenshot.png" })).toBeNull();
    expect(screen.getByTitle<HTMLButtonElement>("Loading attachments…").disabled).toBe(true);
    await act(async () => {
      current.resolve({ ...image, id: 19, name: "current.png" });
      await current.promise;
    });
    fireEvent.click(screen.getByTitle(SEND));
    await waitFor(() =>
      expect(sends).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          attachments: [{ ...attachments.toWire(image), name: "current.png" }],
        }),
      ),
    );
  });

  it("reports failed reads and lets the user retry", async () => {
    vi.spyOn(attachments, "fileToPending")
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(image);
    const { input, sends } = await setup();
    paste(input);
    await waitFor(() =>
      expect(notifications.toast).toHaveBeenCalledWith(
        "Some attachments could not be loaded. Try again.",
        "error",
      ),
    );
    expect(screen.queryByTitle("Loading attachments…")).toBeNull();
    expect(sends).not.toHaveBeenCalled();
    paste(input);
    await screen.findByRole("button", { name: "Remove screenshot.png" });
    fireEvent.click(screen.getByTitle(SEND));
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
  });

  it("preserves the draft and explains how to send attachments when addressing Ken", async () => {
    const { input, sends } = await setup();
    const ken = vi.mocked(currentPane!.sendKenPrompt);
    fireEvent.change(input, { target: { value: "@Ken check this screenshot" } });
    paste(input);
    await screen.findByRole("button", { name: "Remove screenshot.png" });
    fireEvent.click(screen.getByTitle(SEND));
    expect(ken).not.toHaveBeenCalled();
    expect(input.value).toBe("@Ken check this screenshot");
    expect(screen.getByRole("button", { name: "Remove screenshot.png" })).toBeTruthy();
    expect(notifications.toast).toHaveBeenCalledWith(
      // Fork: product name is Local Fork branding (upstream: "GG").
      "Ken cannot receive attachments. Remove @Ken to send them to Supah Coder.",
      "warning",
    );
    fireEvent.change(input, { target: { value: "check this screenshot" } });
    fireEvent.click(screen.getByTitle(SEND));
    await waitFor(() =>
      expect(sends).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ attachments: [attachments.toWire(image)] }),
      ),
    );
  });
});
