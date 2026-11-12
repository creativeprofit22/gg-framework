// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";
import type { PaneSwapViewState } from "./usePaneSwapViewState";
import type * as ToastModule from "./toast";
import { Toaster } from "./Toaster";
import { MOTION_STARTERS } from "./motion-starters";
import { withRealSidecar } from "../../packages/ggcoder/src/test-support/real-sidecar";
import { AgentPane } from "./AgentPane";
import {
  preferredRoadmapPhaseSession,
  resolveRoadmapPhaseResume,
  resolveRoadmapPhaseResumeFromNotes,
} from "./roadmap-phase-resume";
import type { PaneSessionTarget } from "./agent";
import {
  nativeMocks,
  target,
  chatTarget,
  motionTarget,
  agentState,
  projectTask,
  deferred,
  paneEvents,
  liveEvents,
  client,
  renderKenPromptPane,
  openTasksModal,
  findTasksPanel,
  openAutopilotToggle,
  expectAutopilotChecked,
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

describe("preferredRoadmapPhaseSession", () => {
  it("prefers the execution transcript and falls back to the compatibility session", () => {
    const compatibility = { sessionId: "planning", sessionPath: "/planning.jsonl" };
    const implementation = { sessionId: "implementation", sessionPath: "/implementation.jsonl" };

    expect(
      preferredRoadmapPhaseSession(
        { session: compatibility, execution: { lastSession: implementation } },
        compatibility,
      ),
    ).toBe(implementation);
    expect(preferredRoadmapPhaseSession({ session: compatibility }, implementation)).toBe(
      compatibility,
    );
  });

  it("resumes the preferred session without treating historical reconciliation as a gate", () => {
    const stale = { sessionId: "planning", sessionPath: "/planning.jsonl" };
    const implementation = { sessionId: "implementation", sessionPath: "/implementation.jsonl" };

    const blocked = resolveRoadmapPhaseResume(
      {
        session: stale,
        execution: { state: "needs-reconciliation", lastSession: implementation },
      },
      stale,
    );
    expect(blocked).toEqual({ status: "ready", session: implementation });
    expect(
      resolveRoadmapPhaseResume(
        { session: stale, execution: { state: "implementing", lastSession: implementation } },
        stale,
      ),
    ).toEqual({ status: "ready", session: implementation });
    expect(resolveRoadmapPhaseResume({ session: stale }, implementation)).toEqual({
      status: "ready",
      session: stale,
    });
  });

  it("fails closed when Notes state cannot be verified while preserving missing legacy Notes", async () => {
    const pane = client("resume-preflight", 1);
    const compatibility = { sessionId: "planning", sessionPath: "/planning.jsonl" };
    vi.mocked(pane.getNotes).mockRejectedValueOnce(new Error("Notes unavailable"));

    await expect(
      resolveRoadmapPhaseResumeFromNotes(pane, "phase-1", compatibility),
    ).resolves.toEqual({
      status: "blocked",
      message:
        "Couldn’t verify whether this phase needs reconciliation. Open Project Notes and retry Resume.",
    });

    vi.mocked(pane.getNotes).mockResolvedValueOnce({ status: "missing" });
    await expect(
      resolveRoadmapPhaseResumeFromNotes(pane, "legacy-phase", compatibility),
    ).resolves.toEqual({ status: "ready", session: compatibility });
  });
});

describe("empty session starting points", () => {
  it("fills the composer from a starter without sending, and hides starters while typing", async () => {
    const pane = client("empty-starters", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);

    const group = await screen.findByRole("group", { name: "Ways to start" });
    expect(screen.getByText("Pick a starting point below or type your own request.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Fix a bug" }));

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("Find and fix this bug: ");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    // A filled composer counts as typing: the starters step aside.
    expect(screen.queryByRole("group", { name: "Ways to start" })).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    expect(await screen.findByRole("group", { name: "Ways to start" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "my own request" } });
    expect(screen.queryByRole("group", { name: "Ways to start" })).toBeNull();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("offers chat starters in a chat session", async () => {
    const pane = client("empty-chat-starters", 1);
    vi.mocked(pane.getState).mockResolvedValue({ ...agentState("azure:gpt-test"), mode: "chat" });
    render(<AgentPane client={pane} target={chatTarget} />);

    const group = await screen.findByRole("group", { name: "Ways to start" });
    expect(within(group).getByRole("button", { name: "Brainstorm ideas" })).toBeTruthy();
    expect(within(group).queryByRole("button", { name: "Fix a bug" })).toBeNull();
  });

  it("offers video ideas in a motion session that fill the composer and hide while typing", async () => {
    const pane = client("empty-motion-starters", 1);
    vi.mocked(pane.getState).mockResolvedValue({ ...agentState("azure:gpt-test"), mode: "motion" });
    render(<AgentPane client={pane} target={motionTarget} />);

    const group = await screen.findByRole("group", { name: "Video ideas to start from" });
    expect(screen.queryByRole("group", { name: "Ways to start" })).toBeNull();

    const [first] = MOTION_STARTERS;
    const firstButton = within(group).getAllByRole("button")[0];
    if (!firstButton) throw new Error("expected a motion starter button");
    expect(firstButton.textContent).toContain(first.label);
    fireEvent.click(firstButton);

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe(first.prompt);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Video ideas to start from" })).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    expect(await screen.findByRole("group", { name: "Video ideas to start from" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "my own video" } });
    expect(screen.queryByRole("group", { name: "Video ideas to start from" })).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    expect(await screen.findByRole("group", { name: "Video ideas to start from" })).toBeTruthy();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps starters hidden while history loads and for a non-empty conversation", async () => {
    const pane = client("starters-history", 1);
    const history = deferred<AgentModule.HistoryEntry[]>();
    vi.mocked(pane.listHistory).mockReturnValue(history.promise);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);

    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Ways to start" })).toBeNull();

    await act(async () => history.resolve([{ role: "user", text: "Existing prompt" }]));
    expect(await screen.findByText("Existing prompt")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Ways to start" })).toBeNull();
  });

  it("shows starters once an empty history finishes loading", async () => {
    const pane = client("starters-empty-history", 1);
    const history = deferred<AgentModule.HistoryEntry[]>();
    vi.mocked(pane.listHistory).mockReturnValue(history.promise);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);

    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Ways to start" })).toBeNull();
    await act(async () => history.resolve([]));
    expect(await screen.findByRole("group", { name: "Ways to start" })).toBeTruthy();
  });

  it("drafts a task request from empty Tasks without creating, running or sending anything", async () => {
    const pane = client("empty-tasks-draft", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tasks" }));
    const dialog = await findTasksPanel();
    expect(await within(dialog).findByText("No tasks yet")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Draft a task request" }));

    await waitFor(() => expect(screen.queryAllByRole("region", { name: "Tasks" })).toHaveLength(0));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("Break this work into project tasks I can run later: ");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.runTask).not.toHaveBeenCalled();
    expect(pane.runAllTasks).not.toHaveBeenCalled();
    expect(pane.deleteTask).not.toHaveBeenCalled();
  });

  it("keeps unsent composer text when drafting a task request from empty Tasks", async () => {
    const pane = client("empty-tasks-draft-keep", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);

    const tasksButton = await screen.findByRole("button", { name: "Tasks" });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "add login" } });
    fireEvent.click(tasksButton);
    const dialog = await findTasksPanel();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Draft a task request" }));

    await waitFor(() => expect(screen.queryAllByRole("region", { name: "Tasks" })).toHaveLength(0));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Break this work into project tasks I can run later: add login",
    );
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.runTask).not.toHaveBeenCalled();
    expect(pane.runAllTasks).not.toHaveBeenCalled();
    expect(pane.deleteTask).not.toHaveBeenCalled();
  });

  it("says the task list failed to load instead of showing an empty list", async () => {
    const pane = client("empty-tasks-load-failure", 1);
    vi.mocked(pane.listTasks).mockRejectedValue(new Error("session not ready"));
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tasks" }));
    const dialog = await findTasksPanel();
    expect(
      await within(dialog).findByRole("heading", { name: /Couldn.t load tasks/u }),
    ).toBeTruthy();
    expect(within(dialog).queryByText("No tasks yet")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Draft a task request" })).toBeNull();
    expect(nativeMocks.toast).toHaveBeenCalledWith("session not ready", "error");

    // Retrying refetches; once the daemon answers, the genuine empty state appears.
    vi.mocked(pane.listTasks).mockResolvedValue([]);
    const calls = vi.mocked(pane.listTasks).mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("No tasks yet")).toBeTruthy();
    expect(vi.mocked(pane.listTasks).mock.calls.length).toBe(calls + 1);
    expect(within(dialog).getByRole("button", { name: "Draft a task request" })).toBeTruthy();
  });
});

describe("command refresh ordering (mocked native transport)", () => {
  it("does not apply a previous client's catalog after switching sessions", async () => {
    const oldPane = client("old-command-owner", 1);
    const nextPane = client("new-command-owner", 2);
    const pending = deferred<AgentModule.SlashCommand[] | null>();
    const view = render(<AgentPane client={oldPane} target={target} />);
    await waitFor(() => expect(oldPane.listCommands).toHaveBeenCalled());
    vi.mocked(oldPane.listCommands).mockReturnValueOnce(pending.promise);
    await act(async () => {
      fireEvent.focus(window);
    });
    view.rerender(<AgentPane client={nextPane} target={target} />);
    await waitFor(() => expect(nextPane.listCommands).toHaveBeenCalled());
    await act(async () => {
      pending.resolve([
        {
          name: "commit",
          aliases: [],
          description: "Old session only",
          source: "built-in",
          input: { text: "optional", references: "optional", attachments: "optional" },
        },
      ]);
    });
    expect(screen.queryByTitle("Run /commit")).toBeNull();
  });
  it("keeps a successful catalog on failure and ignores older responses after an empty refresh", async () => {
    const pane = client("command-refresh", 1);
    const rows: AgentModule.SlashCommand[] = [
      {
        name: "commit",
        aliases: [],
        description: "Commit changes",
        source: "built-in",
        input: { text: "optional", references: "optional", attachments: "optional" },
      },
    ];
    vi.mocked(pane.listCommands).mockResolvedValue(rows);
    // The 0.91 title bar shows the commit key only for a dirty tree.
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      gitDirtyFileCount: 2,
    });
    render(<AgentPane client={pane} target={target} />);
    await screen.findByTitle("Run /commit");
    vi.mocked(pane.listCommands).mockResolvedValueOnce(null);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(screen.queryByTitle("Run /commit")).not.toBeNull();
    const stale = deferred<AgentModule.SlashCommand[] | null>();
    vi.mocked(pane.listCommands).mockReturnValueOnce(stale.promise).mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.focus(window);
    });
    await act(async () => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(screen.queryByTitle("Run /commit")).toBeNull());
    await act(async () => {
      stale.resolve(rows);
    });
    expect(screen.queryByTitle("Run /commit")).toBeNull();
  });
  it("keeps + New as the header's only primary, with commit secondary and utilities quiet", async () => {
    const pane = client("header-tiers", 1);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "commit",
        aliases: [],
        description: "Commit changes",
        source: "built-in",
        input: { text: "optional", references: "optional", attachments: "optional" },
      },
    ]);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      gitDirtyFileCount: 2,
    });
    const { container } = render(<AgentPane client={pane} target={target} />);

    // Upstream 0.91 title bar: New is the only primary pin; commit is a
    // secondary key showing the dirty count; Tasks is a plain pin.
    const commit = await screen.findByTitle("Run /commit");
    const primaries = container.querySelectorAll(".title-pin-primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent).toBe("New");
    expect(commit.classList).toContain("commit-key");
    expect(commit.classList).not.toContain("title-pin-primary");
    expect(commit.getAttribute("aria-label")).toBe("Commit 2 files");
    const tasks = screen.getByTitle("View and run this project's tasks");
    expect(tasks.classList).toContain("title-pin");
    expect(tasks.classList).not.toContain("title-pin-primary");
    // Arrange (the layout control) moved into the quiet ⋯ More menu.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const more = await screen.findByRole("group", { name: "More" });
    expect(within(more).getByText("Arrange")).toBeTruthy();
  });
  it("becomes ready while the command catalog is still loading", async () => {
    const pane = client("slow-catalog", 1);
    const catalog = deferred<AgentModule.SlashCommand[] | null>();
    vi.mocked(pane.listCommands).mockReturnValue(catalog.promise);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      gitDirtyFileCount: 2,
    });
    render(<AgentPane client={pane} target={target} />);

    await waitFor(() => expect(pane.listTasks).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/connecting to agent/)).toBeNull());
    expect(screen.queryByTitle("Run /commit")).toBeNull();

    await act(async () => {
      catalog.resolve([
        {
          name: "commit",
          aliases: [],
          description: "Commit changes",
          source: "built-in",
          input: { text: "optional", references: "optional", attachments: "optional" },
        },
      ]);
    });
    await screen.findByTitle("Run /commit");
  });
});

describe("AgentPane question acknowledgement", () => {
  beforeAll(async () => {
    // Same cold-renderer setup as the opening fixtures, outside the interaction deadline.
    await import("./Markdown");
  }, 0);

  const question = {
    id: "approval",
    kind: "choice",
    question: "Allow this action?",
    options: [{ label: "Allow action", value: "allow" }],
  };

  it.each(["ready", "state"] as const)(
    "restores exact creation review through %s without replaying approval (mocked native IPC)",
    async (source) => {
      nativeMocks.realMentor = true;
      const pane = client(`ask-reconnect-${source}`, 1);
      const emit = liveEvents(pane);
      const prompt = {
        id: "ask-reconnect",
        questions: [
          {
            ...question,
            kind: "choice" as const,
            detail: "Exact reviewed files: + fixture command",
            allowOther: false,
            options: [
              {
                label: "Create reviewed files",
                value: "host-exact-content-nonce",
                hint: "Creation does not run them",
              },
              { label: "Do not create files", value: "reject", recommended: true },
            ],
          },
        ],
      };
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        ...(source === "state" ? { pendingAsks: [prompt] } : {}),
      });
      const { container } = render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
      await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
      if (source === "ready")
        act(() => emit("ready", { ...agentState("azure:gpt-test"), pendingAsks: [prompt] }));
      await screen.findByRole("button", { name: /Create reviewed files/ });
      act(() => {
        emit("ready", { ...agentState("azure:gpt-test"), pendingAsks: [structuredClone(prompt)] });
        emit("ask_user", prompt);
      });
      expect(container.querySelectorAll(".ask-band")).toHaveLength(1);
      expect(screen.getByText(prompt.questions[0].detail)).toBeTruthy();
      expect(screen.getByText("Creation does not run them")).toBeTruthy();
      expect(pane.answerAskUser).not.toHaveBeenCalled();
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Create reviewed files/ }));
      await waitFor(() =>
        expect(pane.answerAskUser).toHaveBeenCalledExactlyOnceWith("ask-reconnect", "answer", {
          approval: "host-exact-content-nonce",
        }),
      );
    },
  );

  it("connects advice, creation catalog refresh and a distinct run review without replay (mocked native IPC)", async () => {
    nativeMocks.realMentor = true;
    const pane = client("extended-workflow", 1);
    const emit = liveEvents(pane);
    const advice =
      "## What AI found: 1 idea, nothing you need to do\n\nMissing fixture count command. Creation and execution need separate approval.";
    vi.mocked(pane.listHistory).mockResolvedValue([{ role: "assistant", text: advice }]);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const { container } = render(<AgentPane client={pane} target={target} />);
    await screen.findByRole("heading", { name: "What AI found: 1 idea, nothing you need to do" });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.answerAskUser).not.toHaveBeenCalled();
    const creation = {
      id: "create-files-request",
      questions: [
        {
          id: "create-files",
          kind: "choice" as const,
          question: "Create the reviewed fixture command?",
          detail: "Exact file preview: fixture-count.md; creation does not run it.",
          allowOther: false,
          options: [
            { label: "Create reviewed files", value: "create-content-nonce" },
            { label: "Do not create", value: "reject" },
          ],
        },
      ],
    };
    act(() => emit("ask_user", creation));
    fireEvent.click(await screen.findByRole("button", { name: /Create reviewed files/ }));
    await waitFor(() =>
      expect(pane.answerAskUser).toHaveBeenCalledExactlyOnceWith("create-files-request", "answer", {
        "create-files": "create-content-nonce",
      }),
    );
    const run = {
      id: "run-command-request",
      questions: [
        {
          id: "run-command",
          kind: "choice" as const,
          question: "Run the separately reviewed fixture command?",
          detail: "Reviewed read-only run; creating files did not authorize this run.",
          allowOther: false,
          options: [
            { label: "Run reviewed command", value: "run-content-nonce" },
            { label: "Do not run", value: "reject" },
          ],
        },
      ],
    };
    act(() =>
      emit("ask_user_answered", {
        id: creation.id,
        action: "answer",
        answers: { "create-files": "create-content-nonce" },
      }),
    );
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "fixture-count",
        aliases: [],
        description: "New project fixture command",
        source: "custom",
        origin: "project-custom",
        input: { text: "optional", references: "optional", attachments: "optional" },
      },
    ]);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "/fixture" } });
    fireEvent.click(await screen.findByText("/fixture-count"));
    expect((input as HTMLTextAreaElement).value.trim()).toBe("/fixture-count");
    fireEvent.change(input, { target: { value: "/fixture-count two items" } });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    // The native host owns dispatch and emits a different question; renderer must not infer approval.
    act(() => emit("ask_user", run));
    await screen.findByRole("button", { name: /Run reviewed command/ });
    act(() => {
      emit("ready", { ...agentState("azure:gpt-test"), pendingAsks: [structuredClone(run)] });
      emit("ask_user_answered", {
        id: creation.id,
        action: "answer",
        answers: { "create-files": "create-content-nonce" },
      });
    });
    // Resolved creation remains in history; only the run card is actionable.
    expect(container.querySelectorAll(".ask-band")).toHaveLength(2);
    expect(container.querySelectorAll(".ask-band.is-done")).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "GG Coder needs your answer" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Create reviewed files/ })).toBeNull();
    expect(pane.answerAskUser).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Run reviewed command/ })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What AI found: 1 idea, nothing you need to do" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Run reviewed command/ }));
    await waitFor(() =>
      expect(pane.answerAskUser).toHaveBeenNthCalledWith(2, "run-command-request", "answer", {
        "run-command": "run-content-nonce",
      }),
    );
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.programmatic).not.toHaveBeenCalled();
  });

  it("keeps unconfirmed local multi-select drafts across matching ready snapshots", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-reconnect-draft", 1);
    const emit = liveEvents(pane);
    const prompt = {
      id: "ask-draft",
      questions: [
        {
          id: "checks",
          kind: "multi",
          question: "Which checks?",
          options: [{ label: "Typecheck" }, { label: "Tests" }],
        },
      ],
    };
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() => emit("ask_user", prompt));
    fireEvent.click(await screen.findByRole("button", { name: "Typecheck" }));
    act(() =>
      emit("ready", { ...agentState("azure:gpt-test"), pendingAsks: [structuredClone(prompt)] }),
    );
    expect(screen.getByRole("button", { name: "Typecheck" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Confirm 1 selected" })).toBeTruthy();
    expect(pane.answerAskUser).not.toHaveBeenCalled();
    act(() => emit("ready", { ...agentState("azure:gpt-test"), pendingAsks: [] }));
    expect(screen.queryByRole("button", { name: "Confirm 1 selected" })).toBeNull();
    expect(pane.answerAskUser).not.toHaveBeenCalled();
  });

  it.each(["click", "typed"] as const)(
    "does not submit a cleared multi-select when the next answer arrives by %s",
    async (source) => {
      nativeMocks.realMentor = true;
      const pane = client(`ask-clear-${source}`, 1);
      const emit = liveEvents(pane);
      const acknowledgement = deferred<void>();
      vi.mocked(pane.answerAskUser).mockReturnValueOnce(acknowledgement.promise);
      vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
      const { container } = render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
      act(() =>
        emit("ask_user", {
          id: "ask-clear",
          questions: [
            {
              id: "checks",
              kind: "multi",
              question: "Which checks?",
              options: [{ label: "Typecheck" }, { label: "Tests" }],
            },
            {
              id: "then",
              kind: "choice",
              question: "Then what?",
              options: [{ label: "Continue" }, { label: "Stop" }],
            },
          ],
        }),
      );
      // Picks are sent from the band's foot (upstream 0.93.1), so ticking and
      // unticking leaves the multi-select cleared rather than confirmed.
      fireEvent.click(await screen.findByRole("button", { name: "Typecheck" }));
      // Capture the second question's composer target before reopening the first.
      if (source === "typed") fireEvent.keyDown(document, { key: "C" });
      fireEvent.click(screen.getByRole("button", { name: "Typecheck" }));
      if (source === "typed") {
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Continue" } });
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      } else {
        fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      }
      expect(pane.answerAskUser).not.toHaveBeenCalled();
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-ask-question="checks"]')?.hasAttribute("data-ask-answered"),
      ).toBe(false);
      expect(screen.getByRole("button", { name: /Continue/ })).toHaveProperty(
        "ariaPressed",
        "true",
      );
      fireEvent.click(screen.getByRole("button", { name: "Tests" }));
      expect(pane.answerAskUser).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
      expect(pane.answerAskUser).toHaveBeenCalledExactlyOnceWith("ask-clear", "answer", {
        checks: ["Tests"],
        then: "Continue",
      });
      expect(container.querySelector(".ask-band.is-done")).toBeNull();
      await act(async () => acknowledgement.resolve());
      expect(container.querySelector(".ask-band.is-done")).not.toBeNull();
    },
  );

  it("does not show sent until acknowledged, and leaves a transient refusal retryable", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-ack", 1);
    const emit = liveEvents(pane);
    const acknowledgement = deferred<void>();
    vi.mocked(pane.answerAskUser).mockReturnValueOnce(acknowledgement.promise);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const { container } = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() => emit("ask_user", { id: "ask-1", questions: [question] }));
    fireEvent.click(await screen.findByRole("button", { name: /Allow action/ }));
    fireEvent.click(screen.getByRole("button", { name: /Allow action/ }));
    expect(pane.answerAskUser).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".ask-band.is-done")).toBeNull();
    await act(async () => acknowledgement.reject(new Error("session not ready")));
    expect(container.querySelector(".ask-band.is-done")).toBeNull();
    expect(screen.getByRole("button", { name: /Allow action/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Allow action/ }));
    await waitFor(() => expect(container.querySelector(".ask-band.is-done")).not.toBeNull());
  });

  // The daemon's 409 means the tool call is gone (run stopped, timed out,
  // daemon restarted) and ids are never reused, so a retry can never land.
  // The card must say so rather than keep offering a button that does nothing.
  it("marks a question expired when nothing is waiting for the answer", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-expired", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.answerAskUser).mockRejectedValueOnce(
      new Error("no question is awaiting an answer"),
    );
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const { container } = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() => emit("ask_user", { id: "ask-1", questions: [question] }));
    fireEvent.click(await screen.findByRole("button", { name: /Allow action/ }));
    await waitFor(() => expect(container.querySelector(".ask-band.is-closed")).not.toBeNull());
    expect(container.querySelector(".ask-band.is-done")).toBeNull();
    expect(screen.queryByRole("button", { name: /Allow action/ })).toBeNull();
    expect(pane.answerAskUser).toHaveBeenCalledTimes(1);
  });

  // Regression: a question open when the run stopped vanished, so the user had
  // to ask the agent to repeat it. The sidecar now defers it instead.
  it("keeps a question answerable after the run is stopped and sends the late answer", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-after-abort", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const { container } = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() => {
      emit("ask_user", { id: "ask-1", questions: [question] });
      emit("ask_user_deferred", { id: "ask-1" });
      emit("run_end", { cancelled: true });
      // A reconnect while the user was in another pane re-announces it.
      emit("ready", {
        ...agentState("azure:gpt-test"),
        pendingAsks: [],
        deferredAsks: [{ id: "ask-1", questions: [question] }],
      });
    });
    expect(container.querySelector(".ask-band.is-closed")).toBeNull();
    expect(container.querySelector(".ask-deferred-note")?.textContent).toContain("stopped waiting");
    fireEvent.click(await screen.findByRole("button", { name: /Allow action/ }));
    await waitFor(() => expect(pane.answerAskUser).toHaveBeenCalledTimes(1));
    expect(vi.mocked(pane.answerAskUser).mock.calls[0]?.slice(0, 2)).toEqual(["ask-1", "answer"]);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("closes a question deferred by a stopped run once the sidecar supersedes it", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-after-abort-supersede", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() => {
      emit("ask_user", { id: "ask-1", questions: [question] });
      emit("run_end", { cancelled: true });
    });
    await screen.findByRole("button", { name: /Allow action/ });
    act(() => emit("ask_user_settled", { id: "ask-1", action: "cancel" }));
    expect(screen.queryByRole("button", { name: /Allow action/ })).toBeNull();
  });

  // Regression: 2026-09-25 uimaxxxing session. A card with an optional text
  // question (or a multi-select ticked but not confirmed) could never complete,
  // had no send control, and the user could only stop the run — which the agent
  // then saw as an UNKNOWN outcome.
  it("sends a partly answered band, including unconfirmed multi-select ticks", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-partial", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const { container } = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() =>
      emit("ask_user", {
        id: "ask-partial",
        questions: [
          {
            id: "pB",
            kind: "choice",
            question: "Chance it works?",
            options: [{ label: "High" }, { label: "Low" }],
          },
          {
            id: "alone",
            kind: "multi",
            question: "Which would you have thought of?",
            options: [{ label: "Verdict log" }, { label: "Baseline" }],
          },
          { id: "extra", kind: "text", question: "Anything to add? (optional)" },
        ],
      }),
    );
    const send = await screen.findByRole("button", { name: "Send answers" });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /High/ }));
    fireEvent.click(screen.getByRole("button", { name: "Baseline" }));
    // Neither the ticked multi nor the blank optional text commits the band.
    expect(pane.answerAskUser).not.toHaveBeenCalled();
    expect(screen.getByText(/2 of 3 answered/)).toBeTruthy();
    fireEvent.click(send);
    expect(pane.answerAskUser).toHaveBeenCalledExactlyOnceWith("ask-partial", "answer", {
      pB: "High",
      alone: ["Baseline"],
    });
    await waitFor(() => expect(container.querySelector(".ask-band.is-done")).not.toBeNull());
  });

  it.each([
    ["typed", false],
    ["toolbar", false],
    ["typed", true],
    ["toolbar", true],
  ] as const)(
    "settles live approval only after %s send acceptance=%s",
    async (source, accepted) => {
      nativeMocks.realMentor = true;
      const pane = client(`ask-rejected-${source}`, 1);
      const emit = liveEvents(pane);
      const submission = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
      // Toolbar sends can race the running-state event from the host.
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running: source === "typed",
        runState: source === "typed" ? "running" : "idle",
        // The 0.91 title bar shows the commit key only with dirty files.
        gitDirtyFileCount: 1,
      });
      vi.mocked(pane.listCommands).mockResolvedValue([
        {
          name: "commit",
          aliases: [],
          description: "Commit changes",
          source: "built-in",
          input: { text: "optional", references: "optional", attachments: "optional" },
        },
      ]);
      const { container } = render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      act(() => emit("ask_user", { id: "ask-1", questions: [question] }));
      await screen.findByRole("button", { name: /Allow action/ });
      if (source === "typed") {
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Change direction" } });
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      } else {
        fireEvent.click(await screen.findByTitle("Run /commit"));
      }
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: /Allow action/ })).toBeTruthy();
      expect(container.querySelector(".user-msg")).toBeNull();
      if (accepted) {
        act(() =>
          emit("ask_user", {
            id: "ask-2",
            questions: [{ ...question, options: [{ label: "Allow next action" }] }],
          }),
        );
        await act(async () =>
          submission.resolve({ queued: true, count: 1, queueId: "q1", steers: true }),
        );
        expect(screen.getByRole("button", { name: /Allow next action/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Allow action/ })).toBeNull();
        expect(container.querySelectorAll(".user-msg")).toHaveLength(1);
        expect(container.querySelector(".queued-pill")).toBeNull();
        expect(pane.answerAskUser).not.toHaveBeenCalled();
        return;
      }
      await act(async () => submission.reject(new Error("HTTP 409: programmatic_execution_busy")));
      expect(await screen.findByText("Prompt status is uncertain")).toBeTruthy();
      expect(container.querySelector(".queued-pill")).toBeNull();
      expect(container.querySelector(".user-msg")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Allow action/ }));
      await waitFor(() =>
        expect(pane.answerAskUser).toHaveBeenCalledWith("ask-1", "answer", { approval: "allow" }),
      );
      await waitFor(() => expect(container.querySelector(".ask-band.is-done")).not.toBeNull());
    },
  );

  it.each([false, true])(
    "replays real controller question settlement on acceptance=%s",
    async (accepted) => {
      vi.useRealTimers();
      nativeMocks.realMentor = true;
      const { requirePromptSubmissionResult } =
        await vi.importActual<typeof AgentModule>("./agent");
      await withRealSidecar(
        async ({ project, manager, open, request, subscribe }) => {
          const saved = await manager.create(project, "openai", "gpt-5", {
            openAICodexContextProfile: "stable",
          });
          const logicalId = await open(saved.path, "chat");
          const pane = client(logicalId, 1);
          const emit = liveEvents(pane);
          vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
          vi.mocked(pane.sendPrompt).mockImplementation(async (text, attachments, meta) => {
            const response = await request("/prompt", logicalId, { text, attachments, meta });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return requirePromptSubmissionResult(await response.json());
          });
          vi.mocked(pane.answerAskUser).mockImplementation(async (id, action, answers) => {
            const response = await request(`/ask/${id}`, logicalId, { action, answers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          });
          try {
            const { container } = render(<AgentPane client={pane} target={target} />);
            await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
            const stream = await subscribe(logicalId, (event) =>
              act(() => emit(event.type, event.data)),
            );
            await act(async () => {
              expect(
                (await request("/prompt", logicalId, { text: "Ask for approval" })).status,
              ).toBe(202);
              await stream.waitFor("ask_user");
            });
            await screen.findByRole("button", { name: /Allow action/ });
            const askId = stream.events.find((event) => event.type === "ask_user")!.data.id;
            expect(askId).toMatch(/^ask-[0-9a-f-]+-1$/);
            const text = accepted ? "Change direction" : "/research";
            const input = screen.getByRole("textbox");
            fireEvent.change(input, { target: { value: text } });
            fireEvent.keyDown(input, { key: "Enter" });
            if (accepted) {
              await waitFor(() =>
                expect(screen.queryByRole("button", { name: /Allow action/ })).toBeNull(),
              );
              await act(async () => {
                await stream.waitFor("ask_user_settled");
              });
              expect(
                stream.events
                  .filter((event) => event.type === "ask_user_settled")
                  .map((event) => event.data),
              ).toEqual([{ id: askId, action: "cancel" }]);
              expect(pane.answerAskUser).not.toHaveBeenCalled();
            } else {
              await screen.findByText("Prompt status is uncertain");
              expect((input as HTMLTextAreaElement).value).toBe(text);
              expect(container.querySelector(".ask-band.is-done")).toBeNull();
              expect(stream.events.filter((event) => event.type === "ask_user_settled")).toEqual(
                [],
              );
              fireEvent.click(screen.getByRole("button", { name: /Allow action/ }));
              await waitFor(() =>
                expect(container.querySelector(".ask-band.is-done")).not.toBeNull(),
              );
              // The HTTP receipt can update the card before its SSE notification arrives.
              await act(async () => {
                await stream.waitFor("ask_user_settled");
              });
              expect(
                stream.events
                  .filter((event) => event.type === "ask_user_settled")
                  .map((event) => event.data),
              ).toEqual([{ id: askId, action: "answer" }]);
            }
          } finally {
            cleanup();
          }
        },
        { parkQuestion: true },
      );
    },
    60_000,
  );

  it("preserves live approval when Ken's Continue here send is rejected", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-rejected-ken", 1);
    const emit = liveEvents(pane);
    const submission = deferred<AgentModule.PromptSubmissionResult>();
    vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
    const sendButton = await renderKenPromptPane(pane, true);
    act(() => emit("ask_user", { id: "ask-1", questions: [question] }));
    fireEvent.click(sendButton);
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /Allow action/ })).toBeTruthy();
    await act(async () => submission.reject(new Error("HTTP 409: programmatic_execution_busy")));
    expect(document.querySelector(".user-ken-sent")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Allow action/ }));
    await waitFor(() =>
      expect(pane.answerAskUser).toHaveBeenCalledWith("ask-1", "answer", { approval: "allow" }),
    );
    await waitFor(() => expect(document.querySelector(".ask-band.is-done")).not.toBeNull());
  });

  it("host expiry closes only its card and disables click and keyboard answers", async () => {
    nativeMocks.realMentor = true;
    const pane = client("ask-expiry", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    const { container } = render(<AgentPane client={pane} target={target} />);
    // Exercise live expiry after initial hydration, not merely listener setup.
    // 0.91 Deck: the hydrated model shows on the title bar's model key.
    await waitFor(() =>
      expect(container.querySelector(".model-key")?.textContent).toContain("gpt-test"),
    );
    act(() => {
      emit("ask_user", { id: "ask-1", questions: [question] });
      emit("ask_user", {
        id: "ask-2",
        questions: [{ ...question, options: [{ label: "Other action" }] }],
      });
      emit("ask_user_settled", { id: "ask-1", action: "cancel" });
      emit("run_end", {});
    });
    expect(container.querySelectorAll(".ask-band.is-closed")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Allow action/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Other action/ })).toBeTruthy();
    act(() => emit("ask_user_settled", { id: "ask-2", action: "cancel" }));
    fireEvent.keyDown(document, { key: "1" });
    expect(pane.answerAskUser).not.toHaveBeenCalled();
  });
});

describe("AgentPane Autopilot confirmation", () => {
  it("keeps failures off, reports an error, blocks duplicates, and permits retry", async () => {
    const realToast = await vi.importActual<typeof ToastModule>("./toast");
    nativeMocks.toast.mockImplementation(realToast.toast);
    const pane = client("autopilot-failure", 1);
    let reject!: (error: Error) => void;
    vi.mocked(pane.setAutopilot).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const { container } = render(
      <>
        <AgentPane client={pane} target={target} />
        <Toaster />
      </>,
    );
    const toggle = await openAutopilotToggle();
    await waitFor(() => expect(toggle).toMatchObject({ disabled: false }));
    fireEvent.click(toggle);
    expectAutopilotChecked(toggle, false);
    expect(toggle).toMatchObject({ disabled: true });
    expect(container.querySelector(".ken-power-overlay")).toBeNull();
    fireEvent.click(toggle);
    expect(pane.setAutopilot).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("configuration refresh in progress")));
    expectAutopilotChecked(toggle, false);
    expect(toggle).toMatchObject({ disabled: false });
    expect(container.querySelector(".ken-power-overlay")).toBeNull();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("configuration refresh in progress"),
      "error",
    );
    expect(
      // Ignore the Toaster's screen-reader mirror; assert the visible notice.
      screen.getByText(
        "Could not change Autopilot: configuration refresh in progress. Try again.",
        {
          ignore: "script, style, .sr-only *",
        },
      ),
    ).toBeTruthy();
    act(() => realToast.dismissToast(nativeMocks.toast.mock.results[0].value));
    vi.mocked(pane.setAutopilot).mockResolvedValueOnce(true);
    fireEvent.click(toggle);
    await waitFor(() => {
      expectAutopilotChecked(toggle, true);
      expect(toggle).toMatchObject({ disabled: false });
    });
    expect(container.querySelector(".ken-power-banner-on")).not.toBeNull();
  });

  it("honors returned false and reflects valid server events", async () => {
    nativeMocks.realMentor = true;
    const pane = client("autopilot-false", 1);
    const emit = paneEvents(pane);
    vi.mocked(pane.setAutopilot).mockResolvedValue(false);
    const { container } = render(
      <>
        <AgentPane client={pane} target={target} />
        <Toaster />
      </>,
    );
    const toggle = await openAutopilotToggle();
    await waitFor(() => expect(toggle).toMatchObject({ disabled: false }));
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector(".ken-power-banner-off")).not.toBeNull());
    expect(pane.setAutopilot).toHaveBeenCalledWith(true);
    expectAutopilotChecked(toggle, false);
    expect(container.querySelector(".ken-power-banner-on")).toBeNull();
    act(() => emit?.({ type: "autopilot", data: { autopilot: true } }));
    expectAutopilotChecked(toggle, true);
    act(() => emit?.({ type: "autopilot", data: { autopilot: "false" } }));
    expectAutopilotChecked(toggle, true);
    act(() => emit?.({ type: "autopilot", data: { autopilot: false } }));
    expectAutopilotChecked(toggle, false);
  });

  it.each(["resolve", "reject"])(
    "ignores stale %s after replacing the pane session",
    async (outcome) => {
      const pane = client("autopilot-stale", 1);
      let resolve!: (value: boolean) => void;
      let reject!: (error: Error) => void;
      vi.mocked(pane.setAutopilot).mockImplementation(
        () =>
          new Promise((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
      );
      const view = render(
        <AgentPane client={pane} target={target} generation={1} workspaceOwnsSessionLifecycle />,
      );
      const toggle = await openAutopilotToggle();
      await waitFor(() => expect(toggle).toMatchObject({ disabled: false }));
      fireEvent.click(toggle);
      view.rerender(
        <AgentPane
          client={pane}
          target={{ ...target, sessionPath: "/replacement.jsonl" }}
          generation={2}
          workspaceOwnsSessionLifecycle
        />,
      );
      await act(async () => {
        if (outcome === "resolve") resolve(true);
        else reject(new Error("old failure"));
      });
      expectAutopilotChecked(toggle, false);
      expect(view.container.querySelector(".ken-power-overlay")).toBeNull();
      expect(nativeMocks.toast).not.toHaveBeenCalled();
    },
  );
});

describe("AgentPane task request failures", () => {
  it.each([false, true])(
    "renders an accepted task failure and allows retry (all=%s)",
    async (all) => {
      nativeMocks.realMentor = true; // Exercise the real event hook and error renderer.
      const pane = client("accepted-task-failure", 1);
      vi.mocked(pane.runTask).mockResolvedValue(undefined);
      vi.mocked(pane.runAllTasks).mockResolvedValue(undefined);
      const emit = paneEvents(pane);
      vi.mocked(pane.listTasks).mockResolvedValue([projectTask]);
      await openTasksModal(pane);
      fireEvent.click(
        screen.getByRole("button", { name: all ? "Run all (1)" : `Run: ${projectTask.title}` }),
      );
      await waitFor(() =>
        expect(screen.queryAllByRole("region", { name: "Tasks" })).toHaveLength(0),
      );
      act(() => {
        emit?.({ type: "tasks_run_done", data: {} });
        emit?.({
          type: "error",
          data: {
            headline: all ? "Run All stopped" : "Task run stopped",
            message: "Task setup or execution could not finish.",
            guidance:
              "Open Tasks and retry the unfinished task. If it fails again, report the problem.",
          },
        });
      });
      expect(await screen.findByText(all ? "Run All stopped" : "Task run stopped")).toBeTruthy();
      expect(screen.getByText("Task setup or execution could not finish.")).toBeTruthy();
      expect(
        screen.getByText(
          "Open Tasks and retry the unfinished task. If it fails again, report the problem.",
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Tasks, 1 pending" }));
      await findTasksPanel();
      const retry = screen.getByRole("button", { name: `Run: ${projectTask.title}` });
      expect(retry).toMatchObject({ disabled: false });
      fireEvent.click(retry);
      await waitFor(() => expect(pane.runTask).toHaveBeenCalledTimes(all ? 1 : 2));
      expect(pane.runTask).toHaveBeenLastCalledWith(projectTask.id);
    },
  );
  it("disables task launches while Autopilot reviews, then enables them after settlement", async () => {
    const pane = client("task-autopilot-review", 1);
    const emit = paneEvents(pane);
    vi.mocked(pane.listTasks).mockResolvedValue([projectTask]);
    await openTasksModal(pane);
    act(() => emit?.({ type: "autopilot_review_start", data: {} }));
    const single = screen.getByRole("button", { name: `Run: ${projectTask.title}` });
    const all = screen.getByRole("button", { name: "Run all (1)" });
    expect(single).toMatchObject({ disabled: true });
    expect(all).toMatchObject({ disabled: true });
    fireEvent.click(single);
    fireEvent.click(all);
    expect(pane.runTask).not.toHaveBeenCalled();
    expect(pane.runAllTasks).not.toHaveBeenCalled();
    act(() => emit?.({ type: "autopilot_done", data: {} }));
    expect(single).toMatchObject({ disabled: false });
    expect(all).toMatchObject({ disabled: false });
  });
  it("keeps the current tasks visible when refreshing the list fails", async () => {
    const pane = client("pane-task-list-failure", 1);
    let rejectRefresh = false;
    vi.mocked(pane.listTasks).mockImplementation(async () => {
      if (rejectRefresh) throw new Error("task list unavailable");
      return [projectTask];
    });
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);
    const tasksButton = await screen.findByRole("button", { name: "Tasks, 1 pending" });

    rejectRefresh = true;
    fireEvent.click(tasksButton);

    await findTasksPanel();
    expect(screen.getByText(projectTask.title)).toBeTruthy();
    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith("task list unavailable", "error"),
    );
  });

  it("keeps the modal and tasks visible when run-one is rejected", async () => {
    const pane = client("pane-task-run-one-failure", 1);
    vi.mocked(pane.listTasks).mockResolvedValue([projectTask]);
    vi.mocked(pane.runTask).mockRejectedValue(new Error("task cannot start"));
    await openTasksModal(pane);

    fireEvent.click(screen.getByRole("button", { name: `Run: ${projectTask.title}` }));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith("task cannot start", "error"),
    );
    expect(screen.getByText(projectTask.title)).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Tasks" })[0]?.classList).toContain(
      "deck-panel-host",
    );
  });

  it("keeps the modal and tasks visible when run-all is rejected", async () => {
    const pane = client("pane-task-run-all-failure", 1);
    vi.mocked(pane.listTasks).mockResolvedValue([projectTask]);
    vi.mocked(pane.runAllTasks).mockRejectedValue(new Error("task batch cannot start"));
    await openTasksModal(pane);

    fireEvent.click(screen.getByRole("button", { name: "Run all (1)" }));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith("task batch cannot start", "error"),
    );
    expect(screen.getByText(projectTask.title)).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Tasks" })[0]?.classList).toContain(
      "deck-panel-host",
    );
  });

  it("keeps the current tasks visible when delete is rejected", async () => {
    const pane = client("pane-task-delete-failure", 1);
    vi.mocked(pane.listTasks).mockResolvedValue([projectTask]);
    vi.mocked(pane.deleteTask).mockRejectedValue(new Error("task delete refused"));
    await openTasksModal(pane);

    // Deletion is now confirmed inside the modal: the row control only opens
    // the confirmation, and the failure must leave the task in place.
    fireEvent.click(screen.getByRole("button", { name: `Delete task: ${projectTask.title}` }));
    expect(pane.deleteTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith("task delete refused", "error"),
    );
    expect(screen.getByText(projectTask.title)).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("AgentPane automatic update footer banner", () => {
  it("hides local-patched updates while showing official releases", async () => {
    nativeMocks.appUpdate.phase = "available";
    const localPane = client("pane-local-update", 1);
    vi.mocked(localPane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={localPane} target={target} />);
    await screen.findByRole("textbox");

    expect(screen.queryByRole("button", { name: /click to review/u })).toBeNull();

    cleanup();
    nativeMocks.appUpdate.localPatched = false;
    const officialPane = client("pane-official-update", 1);
    vi.mocked(officialPane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={officialPane} target={target} />);

    expect(await screen.findByRole("button", { name: /just updated/u })).toBeTruthy();
  });
});

describe("AgentPane swap reading anchors", () => {
  it.each(["ken", "autopilot"] as const)(
    "retains an unpinned long %s paragraph in both width directions among tool/message rows",
    async (kind) => {
      const pane = client("pane-reading-anchor", 1);
      const prose = "Reading this long paragraph should survive either width exchange. ".repeat(80);
      vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
      vi.mocked(pane.listHistory).mockResolvedValue([
        {
          role: "assistant",
          text: "",
          mcpToolFailure: { name: "mcp__fixture__tool", result: "Earlier tool failure" },
        },
        {
          role: "assistant",
          text: prose,
          ...(kind === "ken"
            ? { ken: true }
            : { autopilot: { phase: "human" as const, reason: prose } }),
        },
        { role: "assistant", text: "Later normal message" },
      ]);
      let view: PaneSwapViewState | null = null;
      render(
        <AgentPane
          client={pane}
          target={target}
          registerSwapViewState={(_id, next) => {
            view = next;
          }}
        />,
      );
      await screen.findByText("Later normal message");
      await waitFor(() =>
        expect(document.querySelector(".ken-msg p")?.textContent).toBe(prose.trim()),
      );
      const scroll = document.querySelector<HTMLDivElement>(".transcript")!;
      const row = scroll.querySelector<HTMLElement>(".ken-msg")!;
      const text = row.querySelector("p")!.firstChild!;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 5000 },
        clientHeight: { configurable: true, value: 200 },
      });
      vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 200,
        width: 400,
        height: 200,
      } as DOMRect);
      let columns = 40;
      for (const el of scroll.children) {
        vi.spyOn(el, "getBoundingClientRect").mockImplementation(() =>
          el === row
            ? ({
                top: 100 - scroll.scrollTop,
                bottom: 4000 - scroll.scrollTop,
                width: columns * 8,
                height: 3900,
              } as DOMRect)
            : ({
                top: el === scroll.firstElementChild ? -200 : 4000,
                bottom: el === scroll.firstElementChild ? -100 : 4100,
                width: 400,
                height: 100,
              } as DOMRect),
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: function (this: Range) {
          if (this.startContainer !== text)
            return { top: -200, bottom: -100, width: 8, height: 100 };
          const top = 100 + Math.floor(this.startOffset / columns) * 20 - scroll.scrollTop;
          const bottom =
            100 +
            (Math.floor(Math.max(this.startOffset, this.endOffset - 1) / columns) + 1) * 20 -
            scroll.scrollTop;
          return { top, bottom, width: 8, height: bottom - top };
        },
      });
      try {
        // The pin follows scroll direction: the reader starts at the newest
        // line (as a live pane does) and scrolls up to the paragraph.
        scroll.scrollTop = 4800;
        fireEvent.scroll(scroll);
        scroll.scrollTop = 300;
        fireEvent.scroll(scroll);
        const narrow = view!.capture();
        columns = 20;
        act(narrow);
        expect(scroll.scrollTop).toBe(500);
        const wide = view!.capture();
        columns = 40;
        act(wide);
        expect(scroll.scrollTop).toBe(300);
        const missing = view!.capture();
        row.remove();
        scroll.scrollTop = 700;
        act(missing);
        expect(scroll.scrollTop).toBe(300);
      } finally {
        if (descriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", descriptor);
        else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    },
  );
});

describe("command palette (Ctrl/Cmd+K)", () => {
  const tagged: AgentModule.SlashCommand[] = [
    {
      name: "demo",
      aliases: [],
      description: "Demo grouped command",
      input: { text: "optional", references: "optional", attachments: "optional" },
      source: "custom",
      origin: "project-custom",
      collection: "demo",
      group: "everyday",
      effect: "reads",
    },
    {
      name: "ungrouped",
      aliases: [],
      description: "In the collection but no group",
      input: { text: "optional", references: "optional", attachments: "optional" },
      source: "custom",
      origin: "project-custom",
      collection: "demo",
    },
    {
      name: "ordinary",
      aliases: [],
      description: "Not in any collection",
      input: { text: "optional", references: "optional", attachments: "optional" },
      source: "custom",
      origin: "project-custom",
    },
  ];

  async function renderPane(
    commands: AgentModule.SlashCommand[],
    props: { focused?: boolean } = {},
    setup?: (pane: ReturnType<typeof client>) => void,
  ) {
    const pane = client(`pane-palette-${randomUUID()}`, 7);
    vi.mocked(pane.listCommands).mockResolvedValue(commands);
    setup?.(pane);
    const view = render(
      <AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle {...props} />,
    );
    // A client with a catalog lists commands and problems in one request.
    await waitFor(() => expect(pane.listCommandCatalog ?? pane.listCommands).toHaveBeenCalled());
    const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    return { pane, input, view };
  }

  const otherTarget: PaneSessionTarget = {
    ...chatTarget,
    cwd: "/other",
    sessionPath: "/other-session",
  };
  const brokenCatalog = {
    commands: tagged.slice(2),
    problems: [{ file: "broken.md", scope: "project" as const, reason: "unreadable" as const }],
  };

  it("does not carry a previous target's problems into the next target", async () => {
    const nextCatalog = deferred<AgentModule.CommandCatalog | null>();
    let onNextTarget = false;
    const { pane, view } = await renderPane(tagged.slice(2), {}, (p) => {
      p.listCommandCatalog = vi.fn(async () =>
        onNextTarget ? nextCatalog.promise : brokenCatalog,
      );
    });
    pressCtrlK();
    await screen.findByRole("region", { name: "1 command file has a problem" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search commands" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    onNextTarget = true;
    view.rerender(<AgentPane client={pane} target={otherTarget} workspaceOwnsSessionLifecycle />);
    await act(async () => {});
    // The new target's catalog has not arrived: the old broken file is gone.
    pressCtrlK();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      nextCatalog.resolve({ commands: tagged, problems: [] });
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    pressCtrlK();
    await screen.findByRole("dialog", { name: "Commands" });
    expect(screen.getByRole("option", { name: /\/demo/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /command file/ })).toBeNull();
  });

  it("drops a previous target's late catalog response", async () => {
    const late = deferred<AgentModule.CommandCatalog | null>();
    let onNextTarget = false;
    const { pane, view } = await renderPane(tagged.slice(2), {}, (p) => {
      p.listCommandCatalog = vi.fn(async () =>
        onNextTarget ? { commands: tagged.slice(2), problems: [] } : late.promise,
      );
    });
    onNextTarget = true;
    view.rerender(<AgentPane client={pane} target={otherTarget} workspaceOwnsSessionLifecycle />);
    await act(async () => {});
    await act(async () => {
      late.resolve(brokenCatalog);
    });
    await act(async () => {});
    pressCtrlK();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the last commands and problems when a catalog refresh fails", async () => {
    let fail = false;
    const { pane } = await renderPane(tagged, {}, (p) => {
      p.listCommandCatalog = vi.fn(async () => {
        if (fail) throw new Error("daemon unavailable");
        return { commands: tagged, problems: brokenCatalog.problems };
      });
    });
    const catalog = vi.mocked(pane.listCommandCatalog);
    await act(async () => {});
    fail = true;
    const before = catalog?.mock.calls.length ?? 0;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(catalog?.mock.calls.length).toBeGreaterThan(before);
    pressCtrlK();
    const panel = await screen.findByRole("region", { name: "1 command file has a problem" });
    expect(within(panel).getByText("broken.md")).toBeTruthy();
    expect(screen.getByRole("option", { name: /\/demo/ })).toBeTruthy();
  });

  it("lists commands without problems when the client has no catalog", async () => {
    const { pane } = await renderPane(tagged);
    expect(pane.listCommandCatalog).toBeUndefined();
    const before = vi.mocked(pane.listCommands).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(vi.mocked(pane.listCommands).mock.calls.length).toBe(before + 1);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "Commands" });
    expect(screen.getByRole("option", { name: /\/demo/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /command file/ })).toBeNull();
  });

  it("lists commands and problems with one request per refresh", async () => {
    const { pane } = await renderPane(tagged.slice(2), {}, (p) => {
      p.listCommandCatalog = vi.fn(async () => ({ commands: tagged.slice(2), problems: [] }));
    });
    const catalog = vi.mocked(pane.listCommandCatalog);
    await act(async () => {});
    const before = catalog?.mock.calls.length ?? 0;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(catalog?.mock.calls.length).toBe(before + 1);
    expect(pane.listCommands).not.toHaveBeenCalled();
  });

  function pressCtrlK(): void {
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  }

  it("pages the focused pane's transcript with Page Up / Page Down from the composer", async () => {
    const { input, view } = await renderPane([]);
    const transcript = view.container.querySelector<HTMLDivElement>(".transcript");
    if (!transcript) throw new Error("transcript missing");
    const scrollBy = vi.fn();
    transcript.scrollBy = scrollBy as typeof transcript.scrollBy;
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 4000 });
    const up = fireEvent.keyDown(input, { key: "PageUp" });
    const down = fireEvent.keyDown(input, { key: "PageDown" });
    // fireEvent returns false once the handler has claimed the key.
    expect([up, down]).toEqual([false, false]);
    expect(scrollBy.mock.calls.map(([options]) => (options as ScrollToOptions).top)).toEqual([
      -700, 700,
    ]);
    // Shift+Page keys still select text in the composer.
    fireEvent.keyDown(input, { key: "PageUp", shiftKey: true });
    expect(scrollBy).toHaveBeenCalledTimes(2);
  });

  it("leaves Page Up / Page Down alone in an unfocused pane", async () => {
    const { input, view } = await renderPane([], { focused: false });
    const transcript = view.container.querySelector<HTMLDivElement>(".transcript");
    if (!transcript) throw new Error("transcript missing");
    const scrollBy = vi.fn();
    transcript.scrollBy = scrollBy as typeof transcript.scrollBy;
    expect(fireEvent.keyDown(input, { key: "PageDown" })).toBe(true);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("opens only collection commands, grouped, and fills the chat box on Enter", async () => {
    const { pane, input } = await renderPane(tagged);
    const before = vi.mocked(pane.listCommands).mock.calls.length;
    pressCtrlK();
    const search = await screen.findByRole("combobox", { name: "Search commands" });
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /\/demo/ })).toBeTruthy();
    // A collection command without a group sits under Other, never hidden.
    expect(
      within(screen.getByRole("group", { name: "Other" })).getByRole("option", {
        name: /\/ungrouped/,
      }),
    ).toBeTruthy();
    // Ordinary commands stay in the slash menu, not the palette.
    expect(screen.queryByRole("option", { name: /\/ordinary/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /\/schedule/ })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(
      within(screen.getByRole("group", { name: "Everyday" })).getByRole("option", {
        name: /\/demo.*reads.*project/,
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(pane.listCommands).mock.calls.length).toBeGreaterThan(before),
    );

    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Commands" })).toBeNull());
    expect(input.value).toBe("/demo ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("sends through the prompt path on Shift+Enter", async () => {
    const { pane } = await renderPane(tagged);
    pressCtrlK();
    const search = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/demo"));
    expect(screen.queryByRole("dialog", { name: "Commands" })).toBeNull();
  });

  it("queues Shift+Enter through the existing queue while the agent is busy, without interrupting", async () => {
    const { pane, input } = await renderPane(tagged, {}, (p) => {
      vi.mocked(p.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running: true,
        runState: "running",
      });
      vi.mocked(p.sendPrompt).mockResolvedValue({
        queued: true,
        count: 1,
        queueId: "q-palette",
        steers: false,
      });
    });
    // Wait until the pane knows the agent is running (Stop replaces Send).
    await screen.findByRole("button", { name: "Stop response" });
    fireEvent.change(input, { target: { value: "draft in progress" } });
    pressCtrlK();
    const search = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/demo"));
    expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
    expect(pane.cancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Commands" })).toBeNull();
    // Still running: the stop control stays, so the current run was not interrupted.
    expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy();
  });

  it("stays silent when no command declares a collection", async () => {
    await renderPane(tagged.slice(2));
    pressCtrlK();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows command files that could not be read as an error state", async () => {
    const { pane } = await renderPane(tagged, {}, (p) => {
      p.listCommandCatalog = vi.fn(async () => ({
        commands: tagged,
        problems: [{ file: "broken.md", scope: "project" as const, reason: "unreadable" as const }],
      }));
    });
    pressCtrlK();
    const panel = await screen.findByRole("region", { name: "1 command file has a problem" });
    expect(within(panel).getByText("broken.md")).toBeTruthy();
    expect(pane.listCommandCatalog).toHaveBeenCalled();
    expect(screen.getByRole("option", { name: /\/demo/ })).toBeTruthy();
  });

  it("stays silent with no collection commands when the catalog reports no problems", async () => {
    const { pane } = await renderPane(tagged.slice(2), {}, (p) => {
      p.listCommandCatalog = vi.fn(async () => ({ commands: tagged.slice(2), problems: [] }));
    });
    await waitFor(() => expect(pane.listCommandCatalog).toHaveBeenCalled());
    pressCtrlK();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens with the problem panel when broken files leave no collection commands", async () => {
    const { pane } = await renderPane(tagged.slice(2), {}, (p) => {
      p.listCommandCatalog = vi.fn(async () => ({
        commands: tagged.slice(2),
        problems: [{ file: "broken.md", scope: "global" as const, reason: "unreadable" as const }],
      }));
    });
    // Learned in the background, before the shortcut is pressed.
    await waitFor(() => expect(pane.listCommandCatalog).toHaveBeenCalled());
    await act(async () => {});
    pressCtrlK();
    const panel = await screen.findByRole("region", { name: "1 command file has a problem" });
    expect(within(panel).getByText("broken.md")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No collection commands could be loaded.")).toBeTruthy();
  });

  it("ignores Ctrl+K in an unfocused pane", async () => {
    await renderPane(tagged, { focused: false });
    pressCtrlK();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open over another dialog", async () => {
    await renderPane(tagged);
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    try {
      pressCtrlK();
      await act(async () => {});
      expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull();
    } finally {
      other.remove();
    }
  });
});
