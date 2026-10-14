// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentState,
  ChecklistSnapshot,
  HistoryEntry,
  PaneAgentClient,
  PaneSessionTarget,
  SidecarEvent,
} from "./agent";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { AgentPane } = await import("./AgentPane");
const { fakePaneClient } = await import("./test-support/fake-pane-client");
const target: PaneSessionTarget = { mode: "code", cwd: "/workspaces/checklist", sessionPath: null };
// Fork: each chat pane is AgentPane driven by its own client, so tests render
// the pane directly; App is a multi-pane WorkspaceShell wrapper.
let currentPane: PaneAgentClient | undefined;
function App(): React.ReactElement {
  if (!currentPane) throw new Error("harness() must run before render");
  return <AgentPane client={currentPane} target={target} />;
}
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const transitionDescriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
let composerStyles: HTMLStyleElement;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  // The real composer and footer use flex. Native `hidden` alone loses to
  // author display rules; hiding the chat must not depend on checklist CSS.
  composerStyles = document.createElement("style");
  composerStyles.textContent =
    ".conversation-stack, .transcript-frame, .liveregion, .inputwrap, .footer { display: flex; }";
  document.head.appendChild(composerStyles);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  composerStyles.remove();
  clearMocks();
  currentPane = undefined;
  localStorage.clear();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  if (transitionDescriptor)
    Object.defineProperty(document, "startViewTransition", transitionDescriptor);
  else Reflect.deleteProperty(document, "startViewTransition");
});

const CHECKLIST_PROMPT = `# Checklist: Git & GitHub

Check this project for one item of its health checklist and report in plain words.

Check and report only. Do not edit project files.

- id: \`git-github\``;

const SNAPSHOT: ChecklistSnapshot = {
  staleAfterDays: 30,
  detectionWarnings: [],
  items: [
    {
      id: "git-github",
      group: "Source control",
      title: "Git & GitHub",
      description: "Repository setup",
      check: "Inspect git",
      skill: null,
      setupCommand: null,
      status: "not-run",
      checkedAt: null,
      commit: null,
      uncommittedChanges: false,
      result: null,
      summary: null,
      findings: [],
      evidence: [],
      detection: { summary: "Git initialized", facts: ["Git repository initialized"] },
      runPrompt: CHECKLIST_PROMPT,
    },
    {
      id: "agent-setup",
      group: "Foundations",
      title: "Agent setup",
      description: "A current agent context file and useful skills.",
      check: "Inspect agent instructions",
      skill: null,
      setupCommand: "init",
      status: "not-run",
      checkedAt: null,
      commit: null,
      uncommittedChanges: false,
      result: null,
      summary: null,
      findings: [],
      evidence: [],
      detection: null,
      runPrompt: CHECKLIST_PROMPT.replace("Git & GitHub", "Agent setup"),
    },
  ],
};
function harness(history: HistoryEntry[] = []): {
  fetches: ReturnType<typeof vi.fn>;
  sends: ReturnType<typeof vi.fn>;
  emit: (event: SidecarEvent) => void;
} {
  const state: AgentState = {
    accountId: null,
    openAICodexContextProfileEligibility: { canChange: true },
    openAICodexContextProfile: "stable",
    openAICodexFast: false,
    contextTokens: 0,
    contextWindow: 200_000,
    cwd: "/workspaces/checklist",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running: false,
  };
  const fetches = vi.fn((): ChecklistSnapshot | Promise<ChecklistSnapshot> => SNAPSHOT);
  mockWindows("main");
  mockIPC((command) => (command === "plugin:log|log" ? null : new Promise(() => {})));
  const { pane, sends, emit } = fakePaneClient(state, {
    listHistory: vi.fn(async () => history),
    getChecklist: vi.fn(async () => fetches()),
  });
  currentPane = pane;
  return { fetches, sends, emit };
}

/**
 * The project tools live in the deck's ⋯ keypad, which closes once a tool is
 * picked. `findTool` waits for the window to be ready; `clickTool` opens the
 * keypad (when it isn't already) and presses the named key.
 */
async function findTool(name: string): Promise<string> {
  await screen.findByRole("button", { name: "More" });
  return name;
}
function clickTool(name: string): void {
  if (!screen.queryByRole("region", { name: "More" })) {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
  }
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("checklist workspace navigation", () => {
  it("plays a reply's entrance once while the checklist is open, and none on close", async () => {
    const { emit } = harness();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    const animate = vi.fn(
      (_frames: Keyframe[] | PropertyIndexedKeyframes | null) =>
        ({ cancel: vi.fn() }) as unknown as Animation,
    );
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    try {
      render(<App />);
      const open = await findTool("Checklist");
      const input = screen.getByRole<HTMLTextAreaElement>("textbox");
      fireEvent.change(input, { target: { value: "visible message" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(animate).toHaveBeenCalled());
      const entrances = () =>
        animate.mock.calls.filter(
          (args) => JSON.stringify(args[0]) === '[{"opacity":0},{"opacity":1}]',
        ).length;
      const count = entrances();
      expect(count).toBeGreaterThan(0);
      fireEvent.change(input, { target: { value: "preserved draft" } });
      clickTool(open);
      await screen.findByRole("button", { name: "Check Git & GitHub" });
      // The conversation stays on screen while the checklist is open, so a
      // reply arriving now plays its entrance once, there and then...
      act(() => emit({ type: "text_delta", data: { text: "received while open" } }));
      await waitFor(() => expect(entrances()).toBe(count + 1));
      // ...and closing the checklist replays nothing.
      fireEvent.click(screen.getByRole("button", { name: "Close Checklist" }));
      expect(entrances()).toBe(count + 1);
      expect(input.value).toBe("preserved draft");
      expect(document.querySelector(".row-enter")).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "animate", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });
  it.each(["reopen", "normal-chat completion"])(
    "clears a stale no-result notice after a later record on %s",
    async (refresh) => {
      const { fetches, sends, emit } = harness();
      render(<App />);
      const open = await findTool("Checklist");
      clickTool(open);
      fireEvent.click(await screen.findByRole("button", { name: "Check Git & GitHub" }));
      await waitFor(() => expect(sends).toHaveBeenCalledOnce());
      await act(async () => {
        emit({ type: "run_end", data: {} });
      });
      clickTool(open);
      expect(
        await screen.findByText("No result recorded. View the conversation for details."),
      ).toBeTruthy();
      const recorded: ChecklistSnapshot = {
        ...SNAPSHOT,
        items: SNAPSHOT.items.map((item) =>
          item.id === "git-github"
            ? { ...item, status: "passed", result: "pass", checkedAt: "2026-10-05T12:00:00Z" }
            : item,
        ),
      };
      fetches.mockReturnValue(recorded);
      if (refresh === "reopen") {
        fireEvent.click(screen.getByRole("button", { name: "Close Checklist" }));
        clickTool(open);
      } else {
        await act(async () => {
          emit({ type: "run_end", data: {} });
        });
      }
      expect(await screen.findByText("Checked 5 Oct 2026")).toBeTruthy();
      expect(
        screen.queryByText("No result recorded. View the conversation for details."),
      ).toBeNull();
    },
  );

  it("ignores an older fetch that finishes after a newer record", async () => {
    const { fetches, emit } = harness();
    let resolveOld: ((snapshot: ChecklistSnapshot) => void) | undefined;
    fetches.mockReturnValueOnce(
      new Promise<ChecklistSnapshot>((resolve) => {
        resolveOld = resolve;
      }),
    );
    render(<App />);
    clickTool(await findTool("Checklist"));
    await waitFor(() => expect(fetches).toHaveBeenCalledOnce());
    fetches.mockReturnValue({
      ...SNAPSHOT,
      items: SNAPSHOT.items.map((item) => ({
        ...item,
        status: "passed",
        result: "pass",
        checkedAt: "2026-10-05T12:00:00Z",
      })),
    });
    await act(async () => {
      emit({ type: "run_end", data: {} });
    });
    await waitFor(() => expect(screen.getAllByText("Checked 5 Oct 2026")).toHaveLength(2));
    await act(async () => {
      resolveOld?.(SNAPSHOT);
    });
    expect(screen.getAllByText("Checked 5 Oct 2026")).toHaveLength(2);
    expect(screen.queryByText("Git initialized · Not reviewed")).toBeNull();
  });

  it("runs /init for Agent setup, returns to chat and keeps the draft", async () => {
    const { sends } = harness();
    render(<App />);
    const open = await findTool("Checklist");
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    clickTool(open);
    fireEvent.click(await screen.findByRole("button", { name: "Check Agent setup" }));
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    expect(sends.mock.calls[0]?.[0]).toMatchObject({ text: "/init", attachments: [] });
    expect(screen.queryByRole("region", { name: "Project checklist" })).toBeNull();
    expect(screen.getByText("/init").classList.contains("command-shimmer")).toBe(true);
    expect(screen.queryByText("Checking Agent setup")).toBeNull();
    expect(draft.value).toBe("Keep this draft");
  });
  it("restores the same shimmer label on session return and reload without exposing or recalling the full prompt", async () => {
    const history: HistoryEntry[] = [
      { role: "user", text: "Keep this real user prompt" },
      { role: "user", text: CHECKLIST_PROMPT },
      { role: "assistant", text: "The check is complete." },
    ];
    harness(history);
    // First mount resumes an existing session; the second reloads that same
    // persisted history. Neither relies on the original in-memory label.
    for (let mount = 0; mount < 2; mount++) {
      const view = render(<App />);
      const label = await screen.findByText("Checking Git & GitHub");
      expect(label.classList.contains("command-shimmer")).toBe(true);
      expect(label.closest(".user-msg")?.textContent).toBe("Checking Git & GitHub");
      expect(screen.queryByText(/Check this project for one item/)).toBeNull();
      expect(screen.getByText("Keep this real user prompt")).toBeTruthy();
      expect(screen.getByText("The check is complete.")).toBeTruthy();
      const input = screen.getByRole<HTMLTextAreaElement>("textbox");
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("Keep this real user prompt");
      // Recovery is display-only; retain the complete instructions in history.
      expect(history[1]?.text).toBe(CHECKLIST_PROMPT);
      view.unmount();
    }
  });
  it("fetches as it opens, so a fast response cannot get stuck loading", async () => {
    const { fetches } = harness();
    render(<App />);
    clickTool(await findTool("Checklist"));
    await waitFor(() => expect(fetches).toHaveBeenCalledOnce());
    expect(await screen.findByText("Git initialized · Not reviewed")).toBeTruthy();
    expect(screen.queryByText("Reading project setup…")).toBeNull();
  });
  it("opens in the deck over the message box, keeps the chat and draft, and refetches on open", async () => {
    const { fetches } = harness();
    render(<App />);
    const open = await findTool("Checklist");
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(draft, { target: { value: "Keep this unfinished thought" } });
    clickTool(open);
    const checklist = await screen.findByRole("region", { name: "Project checklist" });
    await within(checklist).findByText("Git initialized · Not reviewed");
    expect(screen.queryByRole("dialog")).toBeNull();
    // A deck tool: inside the deck, with the conversation still on screen and
    // the message box stepped aside (inert) rather than unmounted.
    expect(checklist.closest(".deck")).not.toBeNull();
    expect(document.querySelector<HTMLElement>(".transcript-frame")?.style.display).not.toBe(
      "none",
    );
    expect(draft.closest(".deck-main")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Checklist" }));
    expect(screen.queryByRole("region", { name: "Project checklist" })).toBeNull();
    expect(draft.value).toBe("Keep this unfinished thought");
    expect(screen.getByRole("textbox")).toBe(draft);
    clickTool(open);
    await waitFor(() => expect(fetches).toHaveBeenCalledTimes(2));
  });
  it("closes for the report, preserving the draft and preventing duplicate checks", async () => {
    const { sends } = harness();
    render(<App />);
    const open = await findTool("Checklist");
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(draft, { target: { value: "A draft before checking" } });
    clickTool(open);
    fireEvent.click(await screen.findByRole("button", { name: "Check Git & GitHub" }));
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    expect(sends.mock.calls[0]?.[0]).toMatchObject({
      text: SNAPSHOT.items[0]?.runPrompt,
      attachments: [],
    });
    expect(screen.queryByRole("region", { name: "Project checklist" })).toBeNull();
    expect(screen.queryByText("Repository setup")).toBeNull();
    expect(screen.getByText("Checking Git & GitHub").classList.contains("command-shimmer")).toBe(
      true,
    );
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft.value).toBe("A draft before checking");
    clickTool(open);
    const check = await screen.findByRole("button", { name: "Check Git & GitHub" });
    expect(check.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    fireEvent.click(check);
    expect(sends).toHaveBeenCalledOnce();
  });
});
