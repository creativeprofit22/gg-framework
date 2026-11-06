// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";
import { MENTOR_HANDLE } from "./brand";
import { withRealSidecar } from "../../packages/ggcoder/src/test-support/real-sidecar";
import { AgentPane } from "./AgentPane";
import type { PaneInputActions } from "./AgentPane";
import type { AgentState, PaneAgentClient } from "./agent";
import {
  nativeMocks,
  target,
  chatTarget,
  agentState,
  KEN_PROMPT,
  CONTINUATION_PROMPT,
  deferred,
  paneEvents,
  liveEvents,
  client,
  renderKenPromptPane,
  kenNewSession,
  installAgentPaneHooks,
} from "./test-support/agent-pane-harness";

// Vitest hoists vi.mock only from the test file itself; the factories live in the harness.
vi.mock("./ProgrammaticChat", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).programmaticChatModuleMock(importOriginal),
);
vi.mock("@tauri-apps/api/core", async () =>
  (await import("./test-support/agent-pane-harness")).tauriCoreModuleMock(),
);
vi.mock("@tauri-apps/api/webview", async () =>
  (await import("./test-support/agent-pane-harness")).tauriWebviewModuleMock(),
);
vi.mock("@tauri-apps/plugin-dialog", async () =>
  (await import("./test-support/agent-pane-harness")).tauriDialogModuleMock(),
);
vi.mock("@tauri-apps/api/webviewWindow", async () =>
  (await import("./test-support/agent-pane-harness")).tauriWebviewWindowModuleMock(),
);
vi.mock("./useKenMentor", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).kenMentorModuleMock(importOriginal),
);
vi.mock("./useProgress", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).progressModuleMock(importOriginal),
);
vi.mock("./useAgentEvents", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).agentEventsModuleMock(importOriginal),
);
vi.mock("./HomeScreen", async () =>
  (await import("./test-support/agent-pane-harness")).homeScreenModuleMock(),
);
vi.mock("./SettingsScreen", async () =>
  (await import("./test-support/agent-pane-harness")).settingsScreenModuleMock(),
);
vi.mock("./ProjectPicker", async () =>
  (await import("./test-support/agent-pane-harness")).projectPickerModuleMock(),
);
vi.mock("./update", async () =>
  (await import("./test-support/agent-pane-harness")).updateModuleMock(),
);
vi.mock("./build-info", async () =>
  (await import("./test-support/agent-pane-harness")).buildInfoModuleMock(),
);
vi.mock("./sounds", async () =>
  (await import("./test-support/agent-pane-harness")).soundsModuleMock(),
);
vi.mock("./toast", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).toastModuleMock(importOriginal),
);
vi.mock("./RadioButton", async () =>
  (await import("./test-support/agent-pane-harness")).radioButtonModuleMock(),
);
vi.mock("./agent", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).agentModuleMock(importOriginal),
);

installAgentPaneHooks();

describe("AgentPane lifecycle", () => {
  it.each(
    ["same", "new-conversation", "rewind", "epoch-return"].flatMap((change) =>
      ["quick", "composer", "edited-composer"].map((source) => ({ change, source })),
    ),
  )("scopes delayed mentor transport rejection ($change, $source)", async ({ change, source }) => {
    nativeMocks.realMentor = true;
    const pane = client("pane-real-ken-send", 1);
    const emit = liveEvents(pane);
    const kenState = {
      conversationId: "conversation",
      activationEpoch: "epoch",
      activeRunId: null,
    };
    vi.mocked(pane.getState).mockResolvedValue({
      running: false,
      provider: "anthropic",
      model: "test",
      cwd: "/work",
      mode: "code",
      kenState,
    } as AgentModule.AgentState);
    const pending = deferred<void>();
    vi.mocked(pane.sendKenPrompt).mockReturnValue(pending.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const quick = await screen.findByRole("button", { name: "Ken, next?" });
    await waitFor(() => expect((quick as HTMLButtonElement).disabled).toBe(false));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: source === "quick" ? "Keep this draft" : "@Ken next?" },
    });
    if (source === "quick") fireEvent.click(quick);
    else fireEvent.keyDown(input, { key: "Enter" });
    expect(pane.sendKenPrompt).toHaveBeenCalledWith("next?", {
      conversationId: "conversation",
      activationEpoch: "epoch",
    });
    if (source === "edited-composer") fireEvent.change(input, { target: { value: "New draft" } });
    act(() => {
      if (change === "same") emit("extras", { kenState });
      else {
        emit("session_reset", {
          kenState: {
            ...kenState,
            conversationId: change === "new-conversation" ? "NEW" : kenState.conversationId,
            activationEpoch: "reset",
          },
        });
        if (change === "epoch-return") emit("session_reset", { kenState });
      }
    });
    await act(async () => {
      pending.reject(new Error("send rejected for captured target"));
    });
    const current = change === "same";
    expect(screen.queryByText(/send rejected for captured target/) !== null).toBe(current);
    if (current)
      expect(input.value).toBe(
        source === "quick"
          ? "Keep this draft"
          : source === "edited-composer"
            ? "New draft"
            : "@Ken next?",
      );
    else expect(input.value).not.toBe("@Ken next?");
    expect(screen.queryByRole("button", { name: "Cancel Ken's reply" })).toBeNull();
  });

  it("reports a rejected mentor send without claiming a run started", async () => {
    const pane = client("pane-ken-rejected", 1);
    vi.mocked(pane.sendKenPrompt).mockRejectedValue(new Error("mentor busy; retry"));
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Ken, next?" }));
    expect(await screen.findByText(/mentor busy; retry/)).toBeTruthy();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("sends the Ken next quick action directly and adds a Ken-addressed bubble", async () => {
    const pane = client("pane-ken-next", 1);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Ken, next?" }));

    await waitFor(() =>
      expect(pane.sendKenPrompt).toHaveBeenCalledWith("next?", {
        conversationId: "conversation",
        activationEpoch: "epoch",
      }),
    );
    expect(pane.sendKenPrompt).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(document.querySelector(".user-msg.user-ken")?.textContent).toBe(
      `${MENTOR_HANDLE} next?`,
    );
  });

  it("preserves the current draft and attachments when asking Ken what is next", async () => {
    const pane = client("pane-ken-next-draft", 1);
    const actionsRef: { current: PaneInputActions | null } = { current: null };
    render(
      <AgentPane
        client={pane}
        registerInput={(_paneId, nextActions) => {
          actionsRef.current = nextActions;
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    await waitFor(() => expect(actionsRef.current).toBeTruthy());

    await act(async () => {
      actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Remove file.txt" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ken, next?" }));

    await waitFor(() =>
      expect(pane.sendKenPrompt).toHaveBeenCalledWith("next?", {
        conversationId: "conversation",
        activationEpoch: "epoch",
      }),
    );
    expect((input as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
  });

  it("disables the Ken next quick action while Ken is running", async () => {
    nativeMocks.kenRunning = true;
    const pane = client("pane-ken-next-running", 1);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));

    const quickAction = await screen.findByRole("button", { name: "Ken, next?" });
    expect((quickAction as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(quickAction);
    expect(pane.sendKenPrompt).not.toHaveBeenCalled();
  });

  it("disables the Ken next quick action while plan review blocks input", async () => {
    const pane = client("pane-ken-next-plan", 1);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false),
    );
    const handleEvent = paneEvents(pane);

    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: { planPath: "/plans/next.md", content: "## Steps\n1. Continue" },
      }),
    );

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    expect(await screen.findByRole("region", { name: "Plan approval required" })).toBeTruthy();
    const quickAction = screen.getByRole("button", { name: "Ken, next?" });
    expect((quickAction as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(quickAction);
    expect(pane.sendKenPrompt).not.toHaveBeenCalled();
  });

  it("registers pane-local native-drop staging without subscribing or mutating the title", async () => {
    const pane = client("pane-1", 1);
    const actionsRef: { current: PaneInputActions | null } = { current: null };
    render(
      <AgentPane
        client={pane}
        registerInput={(_paneId, nextActions) => {
          actionsRef.current = nextActions;
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(actionsRef.current).toBeTruthy());

    await act(async () => {
      actionsRef.current?.handleNativeDrop(["/dropped/folder", "/dropped/file.txt"]);
      await Promise.resolve();
    });

    await waitFor(() => expect((input as HTMLTextAreaElement).value).toContain("/dropped/folder"));
    expect(nativeMocks.readDroppedFileAttachment).toHaveBeenCalledWith("/dropped/file.txt");
    expect(nativeMocks.onDragDropEvent).not.toHaveBeenCalled();
    expect(nativeMocks.setWindowTitle).not.toHaveBeenCalled();
  });

  it("continues with the exact hydrated Ken prompt and persists kenSent metadata", async () => {
    const pane = client("pane-ken-current", 1);
    const send = await renderKenPromptPane(pane);

    fireEvent.click(send);

    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true }),
    );
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
    expect(document.querySelector(".user-ken-sent")?.textContent).toContain("Sent to");
  });

  it("a failed Ken prompt send leaves no bubble, explains itself, and re-enables Continue", async () => {
    const pane = client("pane-ken-send-fails", 1);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("agent_prompt failed"));
    const send = await renderKenPromptPane(pane);

    fireEvent.click(send);

    expect(await screen.findByText("Couldn’t send the prompt. Try again.")).toBeTruthy();
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    expect(document.querySelector(".user-ken-sent")).toBeNull();
    const retry = (await screen.findAllByRole("button", { name: "Continue here" }))[0];
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(
    (["typed-queued", "typed-idle", "toolbar", "ken"] as const).flatMap((source) =>
      (["reset", "anonymous-reset", "generation"] as const).flatMap((replacement) =>
        (["queued", "accepted", "rejected"] as const).map((outcome) => ({
          source,
          replacement,
          outcome,
        })),
      ),
    ),
  )(
    "ignores stale $source $outcome settlement after $replacement",
    async ({ source, replacement, outcome }) => {
      nativeMocks.realMentor = true;
      const pane = client("stale-submission", 1);
      const emit = liveEvents(pane);
      const running = source === "typed-queued" || source === "ken";
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running,
        runState: running ? "running" : "idle",
        // The 0.91 title bar shows the commit key only with dirty files.
        gitDirtyFileCount: 1,
      });
      vi.mocked(pane.listCommands).mockResolvedValue([
        {
          name: "commit",
          aliases: [],
          description: "Commit changes",
          source: "custom",
          input: { text: "optional", references: "optional", attachments: "optional" },
        },
      ]);
      vi.mocked(pane.listHistory).mockResolvedValue([
        { role: "assistant", text: "```prompt\nOld Ken prompt\n```", ken: true },
      ]);
      const old = deferred<AgentModule.PromptSubmissionResult>();
      const fresh = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      const view = render(
        <AgentPane client={pane} target={target} generation={1} workspaceOwnsSessionLifecycle />,
      );
      const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
      await waitFor(() => expect(input.disabled).toBe(false));
      if (source === "ken")
        fireEvent.click(await screen.findByRole("button", { name: "Continue here" }));
      else if (source === "toolbar") fireEvent.click(await screen.findByTitle("Run /commit"));
      else {
        fireEvent.change(input, { target: { value: "Old typed prompt" } });
        fireEvent.keyDown(input, { key: "Enter" });
      }
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(1));
      if (replacement === "generation") {
        vi.mocked(pane.listHistory).mockResolvedValue([
          { role: "assistant", text: "Replacement conversation" },
        ]);
        vi.mocked(pane.waitForReady).mockResolvedValue({
          ready: true,
          error: null,
          generation: 2,
          sessionId: pane.paneId,
        });
        view.rerender(
          <AgentPane
            client={pane}
            target={{ ...target, sessionPath: "/replacement.jsonl" }}
            generation={2}
            workspaceOwnsSessionLifecycle
          />,
        );
        await screen.findByText("Replacement conversation");
        await waitFor(() => expect(input.disabled).toBe(false));
      } else {
        act(() =>
          emit(
            "session_reset",
            replacement === "reset"
              ? {
                  operationId: "replacement",
                  conversationId: "new-conversation",
                  sessionId: "new-session",
                }
              : {},
          ),
        );
      }
      // A replacement conversation can send immediately, even while the old request is pending.
      fireEvent.change(input, { target: { value: "New conversation prompt" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(pane.sendPrompt).toHaveBeenCalledTimes(2);
      const transcript = view.container.querySelector(".transcript")?.textContent;
      await act(async () => {
        if (outcome === "rejected") old.reject(new Error("Obsolete submission failure"));
        else
          old.resolve(
            outcome === "queued"
              ? { queued: true, count: 9, queueId: "old-queue", steers: false }
              : { queued: false, count: 0 },
          );
      });
      expect(view.container.querySelector(".transcript")?.textContent).toBe(transcript);
      expect(view.container.querySelector(".queued-pill")).toBeNull();
      expect(screen.queryByText("Obsolete submission failure")).toBeNull();
      expect(screen.queryByText("Couldn’t send the prompt. Try again.")).toBeNull();
      expect(view.container.querySelectorAll(".user-msg")).toHaveLength(running ? 0 : 1);
      expect(input.value).toBe("New conversation prompt");
      // The old finally must not unlock the new request.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(pane.sendPrompt).toHaveBeenCalledTimes(2);
      await act(async () => fresh.resolve({ queued: false, count: 0 }));
      expect(input.value).toBe("");
      expect(view.container.querySelectorAll(".user-msg")).toHaveLength(1);
    },
  );

  it.each(
    (["reset", "generation"] as const).flatMap((replacement) =>
      [false, true].map((rejected) => ({ replacement, rejected })),
    ),
  )(
    "keeps the new Ken send locked after old settlement ($replacement, rejected=$rejected)",
    async ({ replacement, rejected }) => {
      const pane = client("ken-reset-lock", 1);
      const emit = liveEvents(pane);
      vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
      vi.mocked(pane.listHistory).mockResolvedValue([
        { role: "assistant", text: "```prompt\nOld Ken prompt\n```", ken: true },
      ]);
      const old = deferred<AgentModule.PromptSubmissionResult>();
      const fresh = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      const view = render(
        <AgentPane client={pane} target={target} generation={1} workspaceOwnsSessionLifecycle />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Continue here" }));
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(1));
      const newPrompts = "```prompt\nNew Ken prompt\n```\n\n```prompt\nAnother Ken prompt\n```";
      if (replacement === "generation") {
        vi.mocked(pane.listHistory).mockResolvedValue([
          { role: "assistant", text: newPrompts, ken: true },
        ]);
        vi.mocked(pane.waitForReady).mockResolvedValue({
          ready: true,
          error: null,
          generation: 2,
          sessionId: pane.paneId,
        });
        view.rerender(
          <AgentPane
            client={pane}
            target={{ ...target, sessionPath: "/new-ken.jsonl" }}
            generation={2}
            workspaceOwnsSessionLifecycle
          />,
        );
      } else {
        act(() => {
          emit("session_reset", { conversationId: "new-conversation", sessionId: "new-session" });
          emit("ken_text", { text: newPrompts });
        });
      }
      await screen.findByText("New Ken prompt");
      const buttons = await screen.findAllByRole("button", { name: "Continue here" });
      fireEvent.click(buttons[0]);
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(2));
      expect(pane.sendPrompt).toHaveBeenLastCalledWith("New Ken prompt", [], { kenSent: true });
      await act(async () => {
        if (rejected) old.reject(new Error("obsolete"));
        else old.resolve({ queued: false, count: 0 });
      });
      expect(view.container.querySelector(".user-ken-sent")).toBeNull();
      expect(screen.queryByText("Couldn’t send the prompt. Try again.")).toBeNull();
      fireEvent.click(buttons[1]);
      await screen.findByText("This prompt is already being sent.");
      expect(pane.sendPrompt).toHaveBeenCalledTimes(2);
      await act(async () => fresh.resolve({ queued: false, count: 0 }));
      expect(view.container.querySelectorAll(".user-ken-sent")).toHaveLength(1);
      fireEvent.click(buttons[1]);
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(3));
    },
  );

  it.each([false, true])(
    "reconciles a delayed queued receipt after drain (UI running=%s)",
    async (running) => {
      nativeMocks.realMentor = true;
      const pane = client("delayed-queue", 1);
      vi.mocked(pane.searchFiles).mockResolvedValue([
        { path: "src/context.ts", name: "context.ts" },
      ]);
      const emit = liveEvents(pane);
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running,
        runState: running ? "running" : "idle",
      });
      const submission = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
      const { container } = render(<AgentPane client={pane} target={target} />);
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
      fireEvent.change(input, { target: { value: "@context" } });
      fireEvent.click(await screen.findByText("context.ts"));
      await screen.findByRole("button", { name: "Remove src/context.ts" });
      fireEvent.change(input, { target: { value: "Queued follow-up" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
      const wireText = "Queued follow-up\n\nReferenced files:\n- src/context.ts";
      expect(vi.mocked(pane.sendPrompt).mock.calls[0]?.[0]).toBe(wireText);
      act(() => {
        emit("queued", { count: 1, messages: [{ id: "q1", text: wireText }] });
        emit("queued", { count: 0, messages: [] });
        emit("run_end", {});
      });
      await act(async () =>
        submission.resolve({ queued: true, count: 1, queueId: "q1", steers: false }),
      );
      expect(container.querySelectorAll(".user-msg")).toHaveLength(1);
      expect(container.querySelector(".user-msg.queued")).toBeNull();
      expect(container.querySelector(".user-msg")?.textContent).toContain("Queued follow-up");
      expect(container.querySelector(".user-msg")?.textContent).toContain("context.ts");
      expect(container.querySelector(".user-msg")?.textContent).not.toContain("Referenced files:");
      expect(container.querySelector(".queued-pill")).toBeNull();
    },
  );

  it.each([false, true])("uses typed receipt instead of stale UI running=%s", async (running) => {
    nativeMocks.realMentor = true;
    const pane = client("typed-stale-running", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      running,
      runState: running ? "running" : "idle",
    });
    vi.mocked(pane.sendPrompt).mockResolvedValueOnce(
      running
        ? { queued: false, count: 0 }
        : { queued: true, count: 1, queueId: "q1", steers: false },
    );
    const { container } = render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "Server decides" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    // A deferred receipt moves the optimistic bubble to the queue strip until
    // its own run takes it; an accepted receipt keeps it in the transcript.
    expect(container.querySelectorAll(".user-msg")).toHaveLength(running ? 1 : 0);
    if (!running) {
      act(() => {
        emit("queued", { count: 1, messages: [{ id: "q1", text: "Server decides" }] });
        emit("queued", { count: 0, messages: [] });
      });
      expect(container.querySelectorAll(".user-msg")).toHaveLength(1);
    }
    expect(container.querySelector(".user-msg.queued")).toBeNull();
  });

  it.each([false, true])(
    "uses Ken's queued receipt despite stale UI running=%s",
    async (running) => {
      nativeMocks.realMentor = true;
      const pane = client("ken-stale-running", 1);
      vi.mocked(pane.sendPrompt).mockResolvedValueOnce(
        running
          ? { queued: false, count: 0 }
          : { queued: true, count: 1, queueId: "q1", steers: true },
      );
      const send = await renderKenPromptPane(pane, running);
      fireEvent.click(send);
      await waitFor(() => expect(document.querySelector(".user-ken-sent")).not.toBeNull());
      expect(document.querySelector(".user-ken-sent")?.classList.contains("queued")).toBe(!running);
      expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "does not resurrect Ken's consumed queue after a delayed receipt (running=%s)",
    async (running) => {
      nativeMocks.realMentor = true;
      const pane = client("ken-delayed-queue", 1);
      const emit = liveEvents(pane);
      const submission = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
      const send = await renderKenPromptPane(pane, running);
      fireEvent.click(send);
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
      act(() => {
        emit("queued", { count: 1, messages: [{ id: "q1", text: KEN_PROMPT }] });
        emit("queued", { count: 0, messages: [] });
        emit("run_end", {});
      });
      await act(async () =>
        submission.resolve({ queued: true, count: 1, queueId: "q1", steers: true }),
      );
      expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
      expect(document.querySelector(".user-ken-sent.queued")).toBeNull();
      expect(document.querySelector(".queued-pill")).toBeNull();
    },
  );

  it("reconciles a toolbar submission against events before its receipt", async () => {
    nativeMocks.realMentor = true;
    const pane = client("toolbar-delayed-queue", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "commit",
        aliases: [],
        description: "Commit changes",
        source: "custom",
        input: { text: "optional", references: "optional", attachments: "optional" },
      },
    ]);
    // The 0.91 title bar shows the commit key only with dirty files.
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      gitDirtyFileCount: 1,
    });
    const submission = deferred<AgentModule.PromptSubmissionResult>();
    vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
    const { container } = render(<AgentPane client={pane} target={target} />);
    fireEvent.click(await screen.findByTitle("Run /commit"));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    act(() => {
      emit("queued", { count: 1, messages: [{ id: "q1", text: "/commit" }] });
      emit("queued", { count: 0, messages: [] });
      emit("run_end", {});
    });
    await act(async () =>
      submission.resolve({ queued: true, count: 1, queueId: "q1", steers: false }),
    );
    expect(container.querySelectorAll(".user-msg")).toHaveLength(1);
    expect(container.querySelector(".user-msg.queued")).toBeNull();
    expect(container.querySelector(".queued-pill")).toBeNull();
  });

  it("queues a Ken current-send during an active run with authoritative queue metadata", async () => {
    const pane = client("pane-ken-queued", 1);
    vi.mocked(pane.sendPrompt).mockResolvedValueOnce({
      queued: true,
      count: 2,
      queueId: "q2",
      steers: true,
    });
    const send = await renderKenPromptPane(pane, true);

    fireEvent.click(send);

    await waitFor(() => expect(document.querySelector(".user-ken-sent.queued")).not.toBeNull());
    expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true });
    expect(document.querySelector(".queued-pill")?.textContent).toBe("queued");
  });

  it.each([
    ["oversized", "x".repeat(8001), "8001"],
    ["whitespace-only", " \r\n\t ", "nonblank"],
    ["emoji oversized", "🙂".repeat(4000) + "x", "8001"],
  ])(
    "blocks %s fresh instructions before confirmation or mutation",
    async (_name, prompt, error) => {
      const pane = client("pane-invalid-instruction", 1);
      await renderKenPromptPane(pane, false, prompt);
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "unsent draft" } });
      fireEvent.click(kenNewSession());
      expect((await screen.findByRole("alert")).textContent).toContain(error);
      expect(screen.getByRole("alert").textContent).toContain("8000");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(input.value).toBe("unsent draft");
      expect(input.disabled).toBe(false);
      expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
      expect(pane.commitContinuation).not.toHaveBeenCalled();
      expect(pane.newSession).not.toHaveBeenCalled();
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["8000 units", "x".repeat(8000)],
    ["CRLF and emoji", "  🙂\r\n\tKeep outer whitespace  \r\n"],
  ])("prepares a valid raw instruction unchanged: %s", async (_name, prompt) => {
    const pane = client("pane-valid-instruction", 1);
    vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) =>
      emitContinuation(pane, request),
    );
    await renderKenPromptPane(pane, false, prompt);
    fireEvent.click(kenNewSession());
    expect(screen.getByLabelText("Selected continuation prompt").textContent).toBe(prompt);
    expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pane.prepareContinuationHandoff).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(pane.commitContinuation).toHaveBeenCalledOnce();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("opens a side-effect-free non-Astra confirmation and cancels without changing the composer", async () => {
    const pane = client("pane-confirm-cancel", 1);
    await renderKenPromptPane(pane);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "unsent draft" } });
    fireEvent.click(kenNewSession());
    expect(screen.getByLabelText("Selected continuation prompt").textContent).toBe(KEN_PROMPT);
    expect(screen.queryByLabelText("Destination context mode")).toBeNull();
    expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Continue in a new session" })).toBeNull(),
    );
    expect(input.value).toBe("unsent draft");
    expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
    expect(pane.setOpenAICodexContextProfile).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  const destination = {
    conversationId: "conversation-2",
    sessionId: "session-2",
    profile: "stable" as const,
  };
  function emitContinuation(
    pane: PaneAgentClient,
    request: AgentModule.ContinuationCommitRequest,
    emitAccepted = true,
  ) {
    const emit = paneEvents(pane);
    const actual = { ...destination, profile: request.profile ?? ("stable" as const) };
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      ...actual,
      openAICodexContextProfile: actual.profile,
    });
    emit({ type: "session_reset", data: { ...actual, operationId: request.operationId } });
    if (emitAccepted)
      emit({
        type: "continuation_accepted",
        data: {
          ...request,
          destination: actual,
          acceptedMessageId: "message-1",
          prompt: CONTINUATION_PROMPT,
          kenSent: true,
        },
      });
    return {
      ...request,
      outcome: "accepted" as const,
      accepted: true as const,
      resetAttempted: true as const,
      destination: actual,
      acceptedMessageId: "message-1",
    };
  }

  it.each(["stable", "experimental"] as const)(
    "commits %s atomically after confirmation despite a locked source",
    async (profile) => {
      const pane = client("pane-atomic", 1);
      const receipt = deferred<AgentModule.ContinuationCommitResponse>();
      vi.mocked(pane.commitContinuation).mockReturnValueOnce(receipt.promise);
      const sourceProfile = profile === "stable" ? "experimental" : "stable";
      await renderKenPromptPane(pane, false, KEN_PROMPT, undefined, {
        provider: "openai",
        model: "gpt-6-astra",
        accountId: "account-1",
        openAICodexContextProfile: sourceProfile,
        openAICodexContextProfileEligibility: { canChange: false, reason: "Started" },
      });
      fireEvent.click(kenNewSession());
      expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
      const selector = screen.getByLabelText("Destination context mode") as HTMLSelectElement;
      expect(selector.value).toBe(sourceProfile);
      expect(selector.disabled).toBe(false);
      fireEvent.change(selector, { target: { value: profile } });
      const confirm = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(pane.commitContinuation).toHaveBeenCalledOnce());
      const request = vi.mocked(pane.commitContinuation).mock.calls[0][0];
      expect(request).toEqual({
        preparedId: "prepared-1",
        operationId: expect.any(String),
        profile,
      });
      expect(pane.prepareContinuationHandoff).toHaveBeenCalledOnce();
      expect(pane.newSession).not.toHaveBeenCalled();
      expect(pane.setOpenAICodexContextProfile).not.toHaveBeenCalled();
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      await act(async () => receipt.resolve(emitContinuation(pane, request)));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
      act(() => emitContinuation(pane, request));
      expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
    },
  );

  it("captures the selected block once despite later mentor output", async () => {
    const pane = client("pane-exact-block", 1);
    vi.mocked(pane.commitContinuation).mockRejectedValueOnce(new Error("lost ack"));
    const selected =
      "Selected café 日本語\\n literal\n  keep indentation <script>not markup</script>";
    await renderKenPromptPane(
      pane,
      false,
      `First instruction\n\`\`\`\n\n\`\`\`prompt\n${selected}`,
    );
    fireEvent.click(kenNewSession(1));
    act(() =>
      paneEvents(pane)({
        type: "ken_text",
        data: { text: "```prompt\nLater instruction\n```" },
      }),
    );
    expect(screen.getByLabelText("Selected continuation prompt").textContent).toBe(selected);
    expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(pane.prepareContinuationHandoff).toHaveBeenCalledWith(selected));
    await screen.findByRole("button", { name: "Check outcome" });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("retries a lost receipt explicitly with the same operation and never duplicates the accepted bubble", async () => {
    const pane = client("pane-receipt", 1);
    vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) => {
      emitContinuation(pane, request);
      throw new Error("lost ack");
    });
    await renderKenPromptPane(pane);
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const retry = await screen.findByRole("button", { name: "Check outcome" });
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
    const request = vi.mocked(pane.commitContinuation).mock.calls[0][0];
    vi.mocked(pane.commitContinuation).mockResolvedValueOnce({
      ...request,
      outcome: "accepted",
      accepted: true,
      resetAttempted: true,
      destination,
      acceptedMessageId: "message-1",
    });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pane.commitContinuation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pane.commitContinuation).mock.calls[1][0]).toEqual(request);
    expect(pane.prepareContinuationHandoff).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["rejected", "partial", "outcome-unknown"] as const)(
    "recovers complete text and selected mode after %s without resending",
    async (outcome) => {
      const pane = client("pane-recovery", 1);
      vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) => {
        const base = { ...request, message: "Controlled failure" };
        if (outcome === "rejected")
          return { ...base, outcome, accepted: false, resetAttempted: false };
        if (outcome === "partial")
          return { ...base, outcome, accepted: false, resetAttempted: true };
        return { ...base, outcome, accepted: null, resetAttempted: true };
      });
      await renderKenPromptPane(pane, false, KEN_PROMPT, undefined, {
        provider: "openai",
        model: "gpt-6-astra",
        accountId: "account-1",
        openAICodexContextProfile: "experimental",
      });
      fireEvent.click(kenNewSession());
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
          CONTINUATION_PROMPT,
        ),
      );
      expect((screen.getByLabelText("Destination context mode") as HTMLSelectElement).value).toBe(
        "experimental",
      );
      expect(screen.getByRole("dialog").textContent).toContain(
        outcome === "outcome-unknown" ? "Acceptance is unknown" : "No continuation was accepted",
      );
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      expect(pane.newSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    "provider failure",
    "malformed synthesis",
    "next instruction is too long",
    "HTTP 413: Request body too large",
    "Session is busy. Retry preparation when idle.",
  ])("fails closed before commit on %s", async (message) => {
    const pane = client("pane-prepare-failure", 1);
    vi.mocked(pane.prepareContinuationHandoff).mockRejectedValueOnce(
      message.startsWith("HTTP") ? message : new Error(message),
    );
    await renderKenPromptPane(pane);
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No reset or submission was requested",
    );
    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(screen.getByRole("dialog").textContent).toContain(message);
    if (message.includes("413") || message === "next instruction is too long") {
      for (const surface of [screen.getByRole("alert"), screen.getByRole("dialog")]) {
        expect(surface.textContent).toContain("Shorten the continuation instruction");
        expect(surface.textContent).toContain(`current length: ${KEN_PROMPT.length}`);
        expect(surface.textContent).toContain("maximum: 8000");
        expect(surface.textContent).toContain("Nothing has been truncated");
      }
    }
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(KEN_PROMPT);
    expect(pane.commitContinuation).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0],
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(kenNewSession());
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pane.prepareContinuationHandoff).toHaveBeenCalledOnce();
  });

  it("ignores wrong-operation and wrong-destination resets and late duplicate resets around acceptance", async () => {
    const pane = client("pane-reset-identity", 1);
    const receipt = deferred<AgentModule.ContinuationCommitResponse>();
    vi.mocked(pane.commitContinuation).mockReturnValueOnce(receipt.promise);
    await renderKenPromptPane(pane);
    vi.mocked(pane.waitForReady).mockClear();
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(pane.commitContinuation).toHaveBeenCalledOnce());
    const request = vi.mocked(pane.commitContinuation).mock.calls[0][0];
    const emit = paneEvents(pane);
    act(() =>
      emit({ type: "session_reset", data: { ...destination, operationId: "wrong-operation" } }),
    );
    expect(document.querySelector(".ken-prompt-body")?.textContent).toBe(KEN_PROMPT);
    // A forged/mismatched accepted event cannot insert into the source transcript.
    act(() =>
      emit({
        type: "continuation_accepted",
        data: {
          ...request,
          destination,
          acceptedMessageId: "wrong-message",
          prompt: CONTINUATION_PROMPT,
          kenSent: true,
        },
      }),
    );
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(0);
    await act(async () =>
      receipt.resolve({
        ...request,
        outcome: "accepted",
        accepted: true,
        resetAttempted: true,
        destination,
        acceptedMessageId: "message-1",
      }),
    );
    await waitFor(() => expect(pane.waitForReady).toHaveBeenCalled());
    act(() =>
      emit({
        type: "session_reset",
        data: {
          ...destination,
          conversationId: "wrong-destination",
          operationId: request.operationId,
        },
      }),
    );
    expect(document.querySelector(".ken-prompt-body")?.textContent).toBe(KEN_PROMPT);
    act(() => emitContinuation(pane, request));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
    act(() =>
      emit({ type: "session_reset", data: { ...destination, operationId: request.operationId } }),
    );
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(1);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("distinguishes selected and actual modes after a partial persistence failure", async () => {
    const pane = client("pane-partial-mode", 1);
    vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) => ({
      ...request,
      outcome: "partial",
      accepted: false,
      resetAttempted: true,
      destination,
      selectedProfile: "experimental",
      recoveryPrompt: CONTINUATION_PROMPT,
      error: "profile-persistence-failed",
      message: "Saving the destination mode failed",
    }));
    await renderKenPromptPane(pane, false, KEN_PROMPT, undefined, {
      provider: "openai",
      model: "gpt-6-astra",
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
    });
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Reported destination context mode: stable",
      ),
    );
    expect(screen.getByRole("dialog").textContent).toContain("No continuation was accepted");
    expect((screen.getByLabelText("Destination context mode") as HTMLSelectElement).value).toBe(
      "experimental",
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(CONTINUATION_PROMPT);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.setOpenAICodexContextProfile).not.toHaveBeenCalled();
  });

  it("does not attribute an accepted receipt to a different authoritative destination", async () => {
    const pane = client("pane-mismatched-receipt", 1);
    vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) => {
      const receipt = emitContinuation(pane, request, false);
      return {
        ...receipt,
        destination: { ...destination, conversationId: "another-conversation" },
      };
    });
    await renderKenPromptPane(pane);
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "different destination than the observed reset",
      ),
    );
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(0);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("preserves known acceptance when the subsequent destination refresh fails", async () => {
    const pane = client("pane-refresh-failure", 1);
    vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) => {
      const receipt = emitContinuation(pane, request, false);
      vi.mocked(pane.getState).mockRejectedValueOnce(new Error("state unavailable"));
      return receipt;
    });
    await renderKenPromptPane(pane);
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "The server accepted the continuation, but refreshing the destination failed",
      ),
    );
    expect(screen.queryByRole("button", { name: "Check outcome" })).toBeNull();
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(0);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("reports acceptance without inserting a late bubble when its SSE event is missing", async () => {
    const pane = client("pane-missing-event", 1);
    vi.mocked(pane.commitContinuation).mockImplementationOnce(async (request) =>
      emitContinuation(pane, request, false),
    );
    await renderKenPromptPane(pane);
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("transcript event was not observed"),
    );
    expect(document.querySelectorAll(".user-ken-sent")).toHaveLength(0);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["stable", "experimental"] as const)(
    "recovers a withheld real source-daemon reset and ignores its late SSE notification (%s)",
    async (profile) => {
      vi.useRealTimers();
      nativeMocks.realMentor = true;
      await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
        const saved = await manager.create(project, "openai", "gpt-5", {
          openAICodexContextProfile: profile,
        });
        await manager.appendRequiredMessage(saved.path, {
          type: "message",
          id: "old-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Old real transcript" },
        });
        const logicalId = await open(saved.path);
        const otherSaved = await manager.create(project, "openai", "gpt-5", {
          openAICodexContextProfile: profile,
        });
        const otherId = await open(otherSaved.path);
        const readState = async (id: string): Promise<AgentState> => {
          const response = await request("/state", id);
          expect(response.status).toBe(200);
          return response.json();
        };
        const original = await readState(logicalId);
        const otherOriginal = await readState(otherId);
        expect(original.openAICodexContextProfile).toBe(profile);
        expect(otherOriginal.lastNewSessionReset).toBeUndefined();
        const pane = client(logicalId, 1);
        vi.mocked(pane.getState).mockImplementation(() => readState(logicalId));
        vi.mocked(pane.listHistory).mockImplementation(async () => {
          const response = await request("/history", logicalId);
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            history: Awaited<ReturnType<PaneAgentClient["listHistory"]>>;
          };
          return body.history;
        });
        vi.mocked(pane.newSession).mockImplementation(async () => {
          const response = await request("/new-session", logicalId, {});
          expect(response.status).toBe(200);
          return response.json();
        });
        const emit = liveEvents(pane);
        const stream = await subscribe(logicalId, (event) => {
          // The sole dropped notification is captured unchanged for late delivery below.
          if (event.type !== "session_reset") act(() => emit(event.type, event.data));
        });
        try {
          render(<AgentPane client={pane} />);
          fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
          fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
          expect(await screen.findByText("Old real transcript")).toBeTruthy();
          const filesBefore = await manager.list(project);
          vi.mocked(pane.getState).mockClear();
          fireEvent.click(screen.getByTitle("Start a new session for this project"));
          fireEvent.click(screen.getByRole("button", { name: "New Session" }));
          const late = await stream.waitFor("session_reset");
          expect(late.sessionId).toBe(logicalId);
          await waitFor(
            () => expect(screen.queryByRole("dialog", { name: "New Session" })).toBeNull(),
            { timeout: 20_000 },
          );
          const current = await readState(logicalId);
          expect(current.lastNewSessionReset).toMatchObject({
            operationId: late.data.operationId,
            conversationId: current.conversationId,
            sessionId: current.sessionId,
          });
          expect(pane.getState).toHaveBeenCalled();
          expect(screen.queryByText("Old real transcript")).toBeNull();
          expect(nativeMocks.kenStateRef?.current?.conversationId).toBe(current.conversationId);
          expect(nativeMocks.kenStateRef?.current?.sessionId).toBe(current.sessionId);
          expect(current.conversationId).not.toBe(original.conversationId);
          expect(current.sessionId).not.toBe(original.sessionId);
          expect(pane.newSession).toHaveBeenCalledOnce();
          const filesAfter = await manager.list(project);
          expect(filesAfter).toHaveLength(filesBefore.length + 1);
          expect(
            filesAfter.filter((file) => !filesBefore.some((old) => old.id === file.id)),
          ).toHaveLength(1);
          expect(nativeMocks.toast).not.toHaveBeenCalled();
          const input = screen.getByRole("textbox");
          fireEvent.change(input, { target: { value: "Keep this real recovery message" } });
          fireEvent.keyDown(input, { key: "Enter" });
          await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
          // Send remains mocked: no generation route or model invocation is allowed.
          act(() => emit(late.type, late.data));
          expect(screen.getByText("Keep this real recovery message")).toBeTruthy();
          expect(pane.newSession).toHaveBeenCalledOnce();
          expect(await manager.list(project)).toHaveLength(filesAfter.length);
          const otherCurrent = await readState(otherId);
          expect(otherCurrent.lastNewSessionReset).toBeUndefined();
          expect(otherCurrent.conversationId).toBe(otherOriginal.conversationId);
          expect(otherCurrent.sessionId).toBe(otherOriginal.sessionId);
        } finally {
          cleanup();
        }
      });
    },
    90_000,
  );

  it.each(["stable", "experimental"] as const)(
    "recovers a missing toolbar reset event in %s mode without creating another session",
    async (profile) => {
      nativeMocks.realMentor = true;
      const pane = client("pane-reset-recovery", 1);
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        openAICodexContextProfile: profile,
      });
      vi.mocked(pane.listHistory).mockResolvedValue([{ role: "user", text: "Old transcript" }]);
      render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      expect(await screen.findByText("Old transcript")).toBeTruthy();
      const snapshot: AgentState = {
        ...agentState("azure:gpt-test"),
        conversationId: "fresh-conversation",
        sessionId: "fresh-session",
        openAICodexContextProfile: profile,
        lastNewSessionReset: {
          operationId: "operation-1",
          conversationId: "fresh-conversation",
          sessionId: "fresh-session",
        },
      };
      vi.mocked(pane.getState).mockResolvedValue(snapshot);
      vi.useFakeTimers();
      fireEvent.click(screen.getByTitle("Start a new session for this project"));
      fireEvent.click(screen.getByRole("button", { name: "New Session" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_001);
      });
      expect(screen.queryByRole("dialog", { name: "New Session" })).toBeNull();
      expect(nativeMocks.toast).not.toHaveBeenCalled();
      expect(screen.queryByText("Old transcript")).toBeNull();
      expect(nativeMocks.kenStateRef?.current?.conversationId).toBe("fresh-conversation");
      expect(pane.newSession).toHaveBeenCalledOnce();
      expect(pane.sendPrompt).not.toHaveBeenCalled();

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Keep this new message" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(pane.sendPrompt).toHaveBeenCalledOnce();
      const emit = paneEvents(pane);
      act(() => emit({ type: "session_reset", data: snapshot.lastNewSessionReset! }));
      expect(screen.getByText("Keep this new message")).toBeTruthy();
    },
  );

  it.each(
    (["stable", "experimental"] as const).flatMap((profile) =>
      [
        "missing",
        "wrong-operation",
        "wrong-conversation",
        "wrong-session",
        "unavailable",
        "hung",
      ].map((failure) => ({ profile, failure })),
    ),
  )("refuses sends in $profile when reset recovery is $failure", async ({ profile, failure }) => {
    nativeMocks.realMentor = true;
    const pane = client("pane-reset-unconfirmed", 1);
    const actionsRef: { current: PaneInputActions | null } = { current: null };
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      openAICodexContextProfile: profile,
    });
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "user", text: "Preserve old transcript" },
    ]);
    render(
      <AgentPane
        client={pane}
        registerInput={(_id, actions) => {
          actionsRef.current = actions;
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    expect(await screen.findByText("Preserve old transcript")).toBeTruthy();
    const snapshot: AgentState = {
      ...agentState("azure:gpt-test"),
      conversationId: "fresh-conversation",
      sessionId: "fresh-session",
      lastNewSessionReset:
        failure === "missing"
          ? undefined
          : {
              operationId: failure === "wrong-operation" ? "other" : "operation-1",
              conversationId: failure === "wrong-conversation" ? "other" : "fresh-conversation",
              sessionId: failure === "wrong-session" ? "other" : "fresh-session",
            },
    };
    vi.mocked(pane.getState).mockImplementation(() =>
      failure === "unavailable"
        ? Promise.reject(new Error("disconnected"))
        : failure === "hung"
          ? new Promise(() => {})
          : Promise.resolve(snapshot),
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle("Start a new session for this project"));
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_001);
    });
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("confirm which session is active"),
      "error",
      7000,
    );
    expect(screen.getByText("Preserve old transcript")).toBeTruthy();
    expect(pane.newSession).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "New Session" })).toBeNull();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Keep my draft" } });
    await act(async () => {
      actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]);
    });
    expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("Keep my draft");
    expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
    const emit = paneEvents(pane);
    act(() =>
      emit({
        type: "session_reset",
        data: { operationId: "other", conversationId: "other", sessionId: "other" },
      }),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    const receipt = {
      operationId: "operation-1",
      conversationId: "fresh-conversation",
      sessionId: "fresh-session",
    };
    act(() => emit({ type: "session_reset", data: receipt }));
    expect(screen.queryByText("Preserve old transcript")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    act(() => emit({ type: "session_reset", data: receipt }));
    expect(screen.getByText("Keep my draft")).toBeTruthy();
  });

  it("keeps other panes usable and only restores reset authority after successful reopen hydration", async () => {
    nativeMocks.realMentor = true;
    const pane = client("unresolved-reopen", 1);
    const other = client("independent", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    vi.mocked(other.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const first = render(<AgentPane client={pane} />);
    fireEvent.click(await within(first.container).findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await within(first.container).findByRole("textbox");
    const second = render(<AgentPane client={other} />);
    fireEvent.click(await within(second.container).findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const otherInput = await within(second.container).findByRole("textbox");
    vi.mocked(pane.getState).mockRejectedValue(new Error("unavailable"));
    vi.useFakeTimers();
    fireEvent.click(within(first.container).getByTitle("Start a new session for this project"));
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_001);
    });
    fireEvent.change(otherInput, { target: { value: "Independent prompt" } });
    fireEvent.keyDown(otherInput, { key: "Enter" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(other.sendPrompt).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    vi.useRealTimers();
    // A generation change alone and a failed state read cannot restore authority.
    vi.mocked(pane.selectWorkspace).mockResolvedValue(2);
    vi.mocked(pane.waitForReady).mockResolvedValue({
      ready: true,
      error: null,
      generation: 2,
      sessionId: pane.paneId,
    });
    fireEvent.click(
      within(first.container).getByRole("button", { name: /Back to this project's sessions/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    let input = await within(first.container).findByRole("textbox");
    const emit = paneEvents(pane);
    act(() =>
      emit({
        type: "session_reset",
        data: { operationId: "operation-1", conversationId: "late", sessionId: "late" },
      }),
    );
    fireEvent.change(input, { target: { value: "Recovered draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      conversationId: "reopened",
      sessionId: "reopened",
    });
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "user", text: "Authoritative reopened history" },
    ]);
    fireEvent.click(
      within(first.container).getByRole("button", { name: /Back to this project's sessions/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    expect(await within(first.container).findByText("Authoritative reopened history")).toBeTruthy();
    input = within(first.container).getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    act(() =>
      emit({
        type: "session_reset",
        data: { operationId: "operation-1", conversationId: "late", sessionId: "late" },
      }),
    );
    expect(within(first.container).getByText("Recovered draft")).toBeTruthy();
    expect(pane.newSession).toHaveBeenCalledOnce();
  });

  it.each(["stable", "experimental"] as const)(
    "enforces the shared New Chat gate in %s mode",
    async (profile) => {
      nativeMocks.realMentor = true;
      const pane = client("unresolved-chat", 1);
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        mode: "chat",
        openAICodexContextProfile: profile,
      });
      render(<AgentPane client={pane} initialTarget={chatTarget} />);
      const input = await screen.findByRole("textbox");
      vi.mocked(pane.getState).mockRejectedValue(new Error("unavailable"));
      vi.useFakeTimers();
      fireEvent.click(screen.getByTitle("Start a new chat"));
      fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_001);
      });
      fireEvent.change(input, { target: { value: "Keep chat draft" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      expect((input as HTMLTextAreaElement).value).toBe("Keep chat draft");
      expect(pane.newSession).toHaveBeenCalledOnce();
    },
  );

  it("blocks Ken current, fresh and quick sends after unresolved toolbar reset", async () => {
    nativeMocks.realMentor = true;
    const pane = client("unresolved-ken", 1);
    const continueHere = await renderKenPromptPane(pane);
    vi.mocked(pane.getState).mockRejectedValue(new Error("unavailable"));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle("Start a new session for this project"));
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_001);
    });
    fireEvent.click(continueHere);
    fireEvent.click(kenNewSession());
    fireEvent.click(screen.getByRole("button", { name: "Ken, next?" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.sendKenPrompt).not.toHaveBeenCalled();
    expect(pane.prepareContinuationHandoff).not.toHaveBeenCalled();
    expect(pane.commitContinuation).not.toHaveBeenCalled();
    expect(pane.newSession).toHaveBeenCalledOnce();
  });

  it("does not poison prompt authority after a rejected 409 reset", async () => {
    nativeMocks.realMentor = true;
    const { NewSessionError } = await vi.importActual<typeof AgentModule>("./agent");
    const pane = client("rejected-reset", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    vi.mocked(pane.newSession).mockRejectedValue(
      new NewSessionError("creation-rejected", "HTTP 409: busy"),
    );
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const input = await screen.findByRole("textbox");
    fireEvent.click(screen.getByTitle("Start a new session for this project"));
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith(
        expect.stringContaining("current session is unchanged"),
        "error",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(input, { target: { value: "Still usable" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
  });

  it("blocks fresh resets during Autopilot review and shares correlation with the toolbar modal", async () => {
    const pane = client("pane-ken-autopilot", 1);
    await renderKenPromptPane(pane);
    const handleEvent = paneEvents(pane);
    const fresh = kenNewSession();
    const toolbar = screen.getByTitle("Start a new session for this project");

    act(() => handleEvent?.({ type: "autopilot_review_start", data: {} }));
    await waitFor(() => expect((fresh as HTMLButtonElement).disabled).toBe(true));
    expect((toolbar as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(fresh);
    expect(pane.newSession).not.toHaveBeenCalled();

    act(() => handleEvent?.({ type: "autopilot_done", data: {} }));
    await waitFor(() => expect((toolbar as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toolbar);
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledOnce());
    act(() => nativeMocks.onSessionReset?.("unrelated-operation"));
    expect(screen.getByRole("dialog", { name: "New Session" })).toBeTruthy();
    act(() => nativeMocks.onSessionReset?.("operation-1"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New Session" })).toBeNull());
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps ordinary @file mentions on file search", async () => {
    const pane = client("pane-1", 1);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Review @src/brand" } });
    await waitFor(() => expect(pane.searchFiles).toHaveBeenCalled());
    expect(pane.sendKenPrompt).not.toHaveBeenCalled();
  });
});
