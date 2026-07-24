// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, renderHook, act } from "@testing-library/react";
import { createElement, createRef } from "react";
import type { MutableRefObject } from "react";
import { BASH_DIAGNOSTICS_FIXTURE } from "../../packages/ggcoder/src/test-fixtures/bash-diagnostics";

// playSound builds an <audio> element and ./agent calls Tauri APIs at module
// scope (getCurrentWebviewWindow) which blow up in jsdom. Fully stub both. The
// hook only uses `listCommands` from ./agent at runtime (the rest is type-only,
// erased), so the mock just provides that, resolving empty so run_end's command
// refresh is a no-op.
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./agent", () => ({ listCommands: vi.fn().mockResolvedValue([]) }));

import { useAgentEvents, type AgentEventsDeps } from "./useAgentEvents";
import type { Item } from "./App";
import { listCommands } from "./agent";
import type {
  AgentState,
  BackgroundTask,
  BashDiagnostics,
  SidecarEvent,
  SlashCommand,
  TaskOutputDetails,
} from "./agent";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";

const FRONTEND_BASH_DIAGNOSTIC_FIELDS = [
  "executionId",
  "pid",
  "command",
  "cwd",
  "startedAt",
  "timeoutMs",
  "reason",
  "exitCode",
  "signal",
  "elapsedMs",
  "logPath",
  "tail",
  "outputCapped",
  "totalOutputBytes",
  "retainedOutputBytes",
  "droppedOutputBytes",
] as const satisfies readonly (keyof BashDiagnostics)[];
type MissingFrontendBashDiagnosticField = Exclude<
  keyof BashDiagnostics,
  (typeof FRONTEND_BASH_DIAGNOSTIC_FIELDS)[number]
>;
const FRONTEND_BASH_DIAGNOSTIC_CONTRACT_IS_COMPLETE: MissingFrontendBashDiagnosticField extends never
  ? true
  : false = true;

const FRONTEND_TASK_OUTPUT_FIELDS = [
  "isRunning",
  "exitCode",
  "signal",
  "completedAt",
  "startOffset",
  "endOffset",
  "skippedBytes",
  "remainingBytes",
  "logFile",
  "presentationCapped",
] as const satisfies readonly (keyof TaskOutputDetails)[];
type MissingFrontendTaskOutputField = Exclude<
  keyof TaskOutputDetails,
  (typeof FRONTEND_TASK_OUTPUT_FIELDS)[number]
>;
const FRONTEND_TASK_OUTPUT_CONTRACT_IS_COMPLETE: MissingFrontendTaskOutputField extends never
  ? true
  : false = true;

const TASK_OUTPUT_DETAILS_FIXTURE: TaskOutputDetails = {
  isRunning: false,
  exitCode: 0,
  signal: null,
  completedAt: Date.UTC(2026, 6, 24, 12, 34, 56),
  startOffset: 0,
  endOffset: 4_096,
  skippedBytes: 0,
  remainingBytes: 0,
  logFile: "/tmp/background/task-output.log",
  presentationCapped: false,
};

const FRONTEND_BACKGROUND_TASK_FIELDS = [
  "id",
  "pid",
  "command",
  "logFile",
  "startedAt",
  "completedAt",
  "exitCode",
  "signal",
  "isRunning",
] as const satisfies readonly (keyof BackgroundTask)[];
type MissingFrontendBackgroundTaskField = Exclude<
  keyof BackgroundTask,
  (typeof FRONTEND_BACKGROUND_TASK_FIELDS)[number]
>;
const FRONTEND_BACKGROUND_TASK_CONTRACT_IS_COMPLETE: MissingFrontendBackgroundTaskField extends never
  ? true
  : false = true;

const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data }) as SidecarEvent;

function setup(
  handleKenEvent: (e: SidecarEvent) => boolean = () => false,
  initialState: Partial<AgentState> = {},
) {
  let items: Item[] = [];
  let id = 0;
  const setItems = (u: Item[] | ((prev: Item[]) => Item[])): void => {
    items = typeof u === "function" ? u(items) : u;
  };
  const nextId = (): number => ++id;

  // Track the outputs the assertions read; spy the rest so nothing throws.
  let liveToolFeed: LiveToolEntry[] = [];
  let tasks: BackgroundTask[] = [];
  let planReview: string | null = null;
  let commands: SlashCommand[] = [
    { name: "stale", aliases: [], description: "Stale command", source: "custom" },
  ];
  const setLiveToolFeed = vi.fn(
    (u: LiveToolEntry[] | ((p: LiveToolEntry[]) => LiveToolEntry[])) => {
      liveToolFeed = typeof u === "function" ? u(liveToolFeed) : u;
    },
  ) as unknown as AgentEventsDeps["setLiveToolFeed"];
  const setRunning = vi.fn() as unknown as AgentEventsDeps["setRunning"];
  const setTokens = vi.fn() as unknown as AgentEventsDeps["setTokens"];

  // Real reducer-style state holder so functional setState updates (used by
  // model_change / ken_model_change spreads) apply against a base state.
  let agentState: AgentState | null = {
    provider: "anthropic",
    model: "claude-opus-5",
    cwd: "/tmp/proj",
    running: false,
    ...initialState,
  } as AgentState;
  const stateRef = createRef() as MutableRefObject<AgentEventsDeps["stateRef"]["current"]>;
  const setState = ((u: AgentState | null | ((p: AgentState | null) => AgentState | null)) => {
    agentState = typeof u === "function" ? u(agentState) : u;
    stateRef.current = agentState;
  }) as AgentEventsDeps["setState"];

  const noop = (): void => {};
  stateRef.current = agentState;
  const deps: AgentEventsDeps = {
    setItems: setItems as AgentEventsDeps["setItems"],
    nextId,
    handleKenEvent,
    handleAutopilotEvent: () => false,
    setState,
    setTasks: ((update: BackgroundTask[] | ((previous: BackgroundTask[]) => BackgroundTask[])) => {
      tasks = typeof update === "function" ? update(tasks) : update;
    }) as AgentEventsDeps["setTasks"],
    setProjectTasks: noop as unknown as AgentEventsDeps["setProjectTasks"],
    setStatus: noop as unknown as AgentEventsDeps["setStatus"],
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens: noop as unknown as AgentEventsDeps["setContextTokens"],
    setDoneStatus: noop as unknown as AgentEventsDeps["setDoneStatus"],
    setIsThinking: noop as unknown as AgentEventsDeps["setIsThinking"],
    setThinkingStartTs: noop as unknown as AgentEventsDeps["setThinkingStartTs"],
    setThinkingAccumMs: noop as unknown as AgentEventsDeps["setThinkingAccumMs"],
    setPlanTotal: noop as unknown as AgentEventsDeps["setPlanTotal"],
    setPlanDone: noop as unknown as AgentEventsDeps["setPlanDone"],
    setPlanReview: ((u: string | null | ((p: string | null) => string | null)) => {
      planReview = typeof u === "function" ? u(planReview) : u;
    }) as AgentEventsDeps["setPlanReview"],
    setQueuedCount: noop as unknown as AgentEventsDeps["setQueuedCount"],
    setAttachments: noop as unknown as AgentEventsDeps["setAttachments"],
    setCommands: ((update: SlashCommand[] | ((previous: SlashCommand[]) => SlashCommand[])) => {
      commands = typeof update === "function" ? update(commands) : update;
    }) as AgentEventsDeps["setCommands"],
    stateRef,
    planDoneRef: { current: new Set<number>() },
    planTotalRef: { current: 0 },
    planReviewPathRef: { current: null },
    pendingPlanTotalRef: { current: null },
    stickToBottomRef: { current: true },
  };

  const hook = renderHook(
    ({ hookDeps }: { hookDeps: AgentEventsDeps }) => useAgentEvents(hookDeps),
    { initialProps: { hookDeps: deps } },
  );
  return {
    hook,
    deps,
    getItems: () => items,
    getLiveToolFeed: () => liveToolFeed,
    getTasks: () => tasks,
    getPlanReview: () => planReview,
    getCommands: () => commands,
    getState: () => agentState,
    setRunning,
    setTokens,
  };
}

describe("useAgentEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the complete background-task snapshot from ready and tasks events", () => {
    expect(FRONTEND_BACKGROUND_TASK_CONTRACT_IS_COMPLETE).toBe(true);
    const signalTask: BackgroundTask = {
      id: "bg-signal",
      pid: 4242,
      command: "pnpm watch",
      logFile: "/tmp/bg-signal.log",
      startedAt: 1,
      completedAt: 2,
      exitCode: null,
      signal: "SIGTERM",
      isRunning: false,
    };
    expect(Object.keys(signalTask).sort()).toEqual([...FRONTEND_BACKGROUND_TASK_FIELDS].sort());
    const { hook, getTasks } = setup();

    act(() =>
      hook.result.current.handleEvent(ev("ready", { running: false, tasks: [signalTask] })),
    );
    expect(getTasks()).toEqual([signalTask]);

    const normalTask = { ...signalTask, exitCode: 7, signal: null };
    act(() => hook.result.current.handleEvent(ev("tasks", { tasks: [normalTask] })));
    expect(getTasks()).toEqual([normalTask]);
  });

  it("uses the replacement client after the dependency changes", async () => {
    const secondClient = {
      listCommands: vi
        .fn()
        .mockResolvedValue([
          { name: "new", aliases: [], description: "New command", source: "custom" },
        ]),
    };
    const { hook, deps, getCommands } = setup();
    hook.rerender({
      hookDeps: { ...deps, client: secondClient as unknown as AgentEventsDeps["client"] },
    });

    await act(async () => hook.result.current.handleEvent(ev("run_end")));

    expect(secondClient.listCommands).toHaveBeenCalledOnce();
    expect(listCommands).not.toHaveBeenCalled();
    expect(getCommands()).toEqual([
      { name: "new", aliases: [], description: "New command", source: "custom" },
    ]);
  });

  it("keeps the run owned while cancellation is pending", () => {
    const { hook, getState, setRunning } = setup(() => false, {
      running: true,
      runState: "running",
    });
    act(() => hook.result.current.handleEvent(ev("run_cancelling", { runState: "cancelling" })));
    expect(getState()).toMatchObject({ running: true, runState: "cancelling" });
    expect(setRunning).toHaveBeenLastCalledWith(true);
  });

  it("restores the running affordance after cancellation failure", () => {
    const { hook, getState, setRunning } = setup(() => false, {
      running: true,
      runState: "cancelling",
    });
    act(() => hook.result.current.handleEvent(ev("cancel_failed", { runState: "running" })));
    expect(getState()).toMatchObject({ running: true, runState: "running" });
    expect(setRunning).toHaveBeenLastCalledWith(true);
  });

  it("replaces stale commands when a run refresh returns an empty list", async () => {
    vi.mocked(listCommands).mockResolvedValueOnce([]);
    const { hook, getCommands } = setup();

    await act(async () => {
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
      await Promise.resolve();
    });

    expect(listCommands).toHaveBeenCalledOnce();
    expect(getCommands()).toEqual([]);
  });

  it("becomes idle only when the owning run emits run_end", () => {
    const { hook, getState, setRunning } = setup(() => false, {
      running: true,
      runState: "cancelling",
    });
    act(() => hook.result.current.handleEvent(ev("run_end", { cancelled: true })));
    expect(getState()).toMatchObject({ running: false, runState: "idle" });
    expect(setRunning).toHaveBeenLastCalledWith(false);
  });

  it("refreshes branch and uncommitted-file count from workspace extras", () => {
    const { hook, getState } = setup();

    act(() => {
      hook.result.current.handleEvent(
        ev("extras", { gitBranch: "feature/dirty", isGitRepo: true, gitDirtyFileCount: 4 }),
      );
    });

    expect(getState()).toMatchObject({
      gitBranch: "feature/dirty",
      isGitRepo: true,
      gitDirtyFileCount: 4,
    });
  });

  it("text_delta streams assistant text into a single item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Hello" }));
    });
    let items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello" });

    // First-token path creates the bubble synchronously; a second delta buffers
    // via the 100ms flush timer, so flush it by ending the stream
    // (endStreamingText drains the buffer).
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: " world" }));
      hook.result.current.endStreamingText();
    });
    items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello world" });
  });

  it("discards the candidate draft before showing the Ideal hook and reviewed final", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Unreviewed draft" }));
      hook.result.current.handleEvent(ev("text_delta", { text: " tail" }));
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "hook", hook: "ideal" })]);

    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Reviewed final" }));
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "ideal" }),
      expect.objectContaining({ kind: "assistant", text: "Reviewed final" }),
    ]);
  });

  it("error with a structured payload (headline/message/guidance) pushes a structured error item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("error", {
          headline: "Anthropic usage limit reached.",
          message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
          guidance: "Try again once it's back. Your conversation is preserved.",
        }),
      );
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "error",
      headline: "Anthropic usage limit reached.",
      message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
      guidance: "Try again once it's back. Your conversation is preserved.",
    });
  });

  it("keeps Azure reset guidance while dropping diagnostic-only fields from UI items", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("error", {
          headline: "Azure OpenAI returned an error.",
          message: "Temporary capacity failure",
          guidance: "Retry shortly. The provider says to retry after 12:00 PM.",
          resetsAt: 1_785_000_000,
          requestId: "req_safe-123",
          rawBody: '{"headers":{"api-key":"raw-secret"}}',
        }),
      );
    });

    expect(getItems()).toEqual([
      expect.objectContaining({
        kind: "error",
        headline: "Azure OpenAI returned an error.",
        message: "Temporary capacity failure",
        guidance: "Retry shortly. The provider says to retry after 12:00 PM.",
      }),
    ]);
    expect(JSON.stringify(getItems())).not.toContain("req_safe-123");
    expect(JSON.stringify(getItems())).not.toContain("raw-secret");
  });

  it("error with only a message (legacy shape) falls back to a flat text item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("error", { message: "boom" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "error" });
    expect((items[0] as { text: string }).text).toContain("boom");
  });

  it("tool_call_start then tool_call_end drive the live tool feed", () => {
    const { hook, getLiveToolFeed } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_start", { toolCallId: "t1", name: "read", args: { file_path: "a.ts" } }),
      );
    });
    let feed = getLiveToolFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ toolCallId: "t1", status: "running" });

    act(() => {
      hook.result.current.handleEvent(ev("tool_call_end", { toolCallId: "t1", isError: false }));
    });
    feed = getLiveToolFeed();
    expect(feed[0]).toMatchObject({ toolCallId: "t1", status: "done" });
  });

  it("keeps structured task_output metadata on tool_call_end", () => {
    expect(FRONTEND_TASK_OUTPUT_CONTRACT_IS_COMPLETE).toBe(true);
    expect(Object.keys(TASK_OUTPUT_DETAILS_FIXTURE).sort()).toEqual(
      [...FRONTEND_TASK_OUTPUT_FIELDS].sort(),
    );
    const { hook, getLiveToolFeed } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_start", {
          toolCallId: "task-output-1",
          name: "task_output",
          args: { id: "background-1" },
        }),
      );
      hook.result.current.handleEvent(
        ev("tool_call_end", {
          toolCallId: "task-output-1",
          isError: false,
          result: "Process background-1: exited (code 0)",
          details: { taskOutput: TASK_OUTPUT_DETAILS_FIXTURE },
        }),
      );
    });

    expect(getLiveToolFeed()[0]).toMatchObject({
      name: "task_output",
      status: "done",
      details: { taskOutput: TASK_OUTPUT_DETAILS_FIXTURE },
    });
  });

  it.each([
    ["running", { isRunning: true, exitCode: null, completedAt: null }, "running"],
    ["normal exit", {}, "exit 0"],
    ["signal exit", { exitCode: null, signal: "SIGTERM" }, "signal SIGTERM"],
    ["skipped history", { skippedBytes: 512 }, "512 skipped"],
    ["remaining page", { remainingBytes: 128 }, "128 unread"],
    ["presentation cap", { presentationCapped: true }, "output capped"],
  ] satisfies [string, Partial<TaskOutputDetails>, string][])(
    "renders the task_output %s inline summary",
    (_label, overrides, expectedSummary) => {
      const details = { ...TASK_OUTPUT_DETAILS_FIXTURE, ...overrides };
      const panel = render(
        createElement(LiveToolPanel, {
          entries: [
            {
              toolCallId: "task-output-summary",
              name: "task_output",
              args: { id: "background-1" },
              status: "done",
              result: "bounded result text",
              details: { taskOutput: details },
            },
          ],
        }),
      );

      expect(panel.container.textContent).toContain(expectedSummary);
      panel.unmount();
    },
  );

  it("shows bounded task_output metadata and recovery guidance without the output body", () => {
    const taskOutput: TaskOutputDetails = {
      ...TASK_OUTPUT_DETAILS_FIXTURE,
      exitCode: null,
      signal: "SIGTERM",
      startOffset: 262_144,
      endOffset: 524_288,
      skippedBytes: 262_144,
      remainingBytes: 128,
      presentationCapped: true,
    };
    const panel = render(
      createElement(LiveToolPanel, {
        entries: [
          {
            toolCallId: "task-output-details",
            name: "task_output",
            args: { id: "background-1" },
            status: "done",
            result: "DO NOT RENDER THE 256 KIB OUTPUT BODY",
            details: { taskOutput },
          },
        ],
      }),
    );

    expect(panel.container.textContent).not.toContain("DO NOT RENDER THE 256 KIB OUTPUT BODY");
    fireEvent.click(panel.getByRole("button", { name: "Task output details" }));
    expect(panel.getByText("Exited with signal SIGTERM")).toBeTruthy();
    expect(panel.getByText("262144-524288 (end exclusive)")).toBeTruthy();
    expect(panel.getByText("262144 bytes")).toBeTruthy();
    expect(panel.getByText("128 bytes")).toBeTruthy();
    expect(panel.getByText(taskOutput.logFile!)).toBeTruthy();
    expect(panel.getByText(/from_start=true/)).toBeTruthy();
    expect(panel.getByText(/read the next page/)).toBeTruthy();
    expect(panel.getByText(/condensed for presentation/)).toBeTruthy();
  });

  it("suppresses malformed task_output metadata", () => {
    const panel = render(
      createElement(LiveToolPanel, {
        entries: [
          {
            toolCallId: "task-output-invalid",
            name: "task_output",
            args: { id: "background-1" },
            status: "done",
            result: "bounded result text",
            details: {
              taskOutput: { ...TASK_OUTPUT_DETAILS_FIXTURE, endOffset: -1 },
            },
          },
        ],
      }),
    );

    expect(panel.queryByRole("button", { name: "Task output details" })).toBeNull();
    expect(panel.container.textContent).toBe("⏺Read output background-1");
  });

  it("streams bounded bash progress before replacing it with the final result", async () => {
    const { hook, getLiveToolFeed } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_start", {
          toolCallId: "bash-1",
          name: "bash",
          args: { command: "pnpm check" },
        }),
      );
      hook.result.current.handleEvent(
        ev("tool_call_update", {
          toolCallId: "bash-1",
          update: { type: "bash_progress", output: "Checking packages\n", totalBytes: 18 },
        }),
      );
    });

    expect(getLiveToolFeed()[0]).toMatchObject({
      status: "running",
      progressOutput: "Checking packages\n",
    });

    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_update", {
          toolCallId: "bash-1",
          update: {
            type: "bash_progress",
            output: "\u001b[32mAll checks passed\u001b[39m\n",
            totalBytes: 45,
          },
        }),
      );
    });

    expect(getLiveToolFeed()[0]?.progressOutput).toBe(
      "Checking packages\n\u001b[32mAll checks passed\u001b[39m\n",
    );
    const progressPanel = render(createElement(LiveToolPanel, { entries: getLiveToolFeed() }));
    expect(progressPanel.container.textContent).toContain("All checks passed");
    expect(progressPanel.container.textContent).not.toContain("\u001b");
    expect(progressPanel.container.textContent).not.toContain("[32m");

    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_update", {
          toolCallId: "bash-1",
          update: { type: "bash_progress", output: "x".repeat(9_000), totalBytes: 9_036 },
        }),
      );
    });
    expect(getLiveToolFeed()[0]?.progressOutput).toHaveLength(8 * 1024);

    const result = "Exit code: TIMEOUT (120000ms)\nAuthoritative final output";
    const bashDiagnostics = BASH_DIAGNOSTICS_FIXTURE;
    expect(FRONTEND_BASH_DIAGNOSTIC_CONTRACT_IS_COMPLETE).toBe(true);
    expect(Object.keys(bashDiagnostics).sort()).toEqual(
      [...FRONTEND_BASH_DIAGNOSTIC_FIELDS].sort(),
    );
    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_end", {
          toolCallId: "bash-1",
          isError: false,
          result,
          details: { bashDiagnostics },
        }),
      );
    });

    expect(getLiveToolFeed()[0]).toMatchObject({
      status: "done",
      result,
      progressOutput: undefined,
      details: { bashDiagnostics },
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const completedPanel = render(createElement(LiveToolPanel, { entries: getLiveToolFeed() }));
    fireEvent.click(completedPanel.getByRole("button", { name: "Details" }));
    expect(completedPanel.getByText(bashDiagnostics.logPath)).toBeTruthy();
    expect(completedPanel.getByText("Exit code")).toBeTruthy();
    expect(completedPanel.getByText("unavailable")).toBeTruthy();
    expect(completedPanel.getByText(bashDiagnostics.signal)).toBeTruthy();
    expect(completedPanel.getByLabelText("Final command output").textContent).toBe(
      bashDiagnostics.tail,
    );
    await act(async () => {
      fireEvent.click(completedPanel.getByRole("button", { name: "Copy diagnostics" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`Exit code: unavailable\nSignal: ${bashDiagnostics.signal}`),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`Final output:\n${bashDiagnostics.tail}`),
    );

    act(() => hook.result.current.handleEvent(ev("run_end", { cancelled: false })));
    expect(getLiveToolFeed()).toHaveLength(1);
    expect(getLiveToolFeed()[0]?.details).toEqual({ bashDiagnostics });
  });

  it("turn_end accumulates output tokens across turns", () => {
    const { hook, setTokens } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("turn_end", { usage: { outputTokens: 10 } }));
    });
    expect(setTokens).toHaveBeenLastCalledWith(10);
    act(() => {
      hook.result.current.handleEvent(ev("turn_end", { usage: { outputTokens: 5 } }));
    });
    // Accumulates (tokensRef is internal): 10 + 5 = 15.
    expect(setTokens).toHaveBeenLastCalledWith(15);
  });

  it("updates the active chat agent after a handoff", () => {
    const { hook, getState } = setup(() => false, { chatAgent: "general" });
    act(() => {
      hook.result.current.handleEvent(ev("chat_agent_change", { chatAgent: "therapist" }));
    });
    expect(getState()).toMatchObject({ chatAgent: "therapist" });
  });
  it("delegates ken_ events to handleKenEvent and does not handle them locally", () => {
    const handleKenEvent = vi.fn(() => true);
    const { hook, getItems, setRunning } = setup(handleKenEvent);
    act(() => {
      hook.result.current.handleEvent(ev("ken_text_delta", { text: "from ken" }));
      hook.result.current.handleEvent(ev("ken_run_start"));
    });
    expect(handleKenEvent).toHaveBeenCalledTimes(2);
    // Nothing handled locally: no assistant item, run state untouched.
    expect(getItems()).toHaveLength(0);
    expect(setRunning).not.toHaveBeenCalled();
  });

  it("ken_model_change updates Ken's footer model state (falls through ken_ delegation)", () => {
    // useKenMentor's handleKenEvent returns false for ken_model_change (it only
    // owns the chat-bubble events), so the event must reach the main switch —
    // the default setup handleKenEvent mirrors that by returning false.
    const { hook, getState } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("ken_model_change", {
          kenProvider: "openai",
          kenModel: "gpt-5.5",
          kenModelOverride: true,
        }),
      );
    });
    expect(getState()).toMatchObject({
      kenProvider: "openai",
      kenModel: "gpt-5.5",
      kenModelOverride: true,
      // GG Coder's own model is untouched by a Ken pin.
      model: "claude-opus-5",
      provider: "anthropic",
    });

    // Clearing the pin: sidecar broadcasts Ken back on GG Coder's model.
    act(() => {
      hook.result.current.handleEvent(
        ev("ken_model_change", {
          kenProvider: "anthropic",
          kenModel: "claude-opus-5",
          kenModelOverride: false,
        }),
      );
    });
    expect(getState()).toMatchObject({ kenModel: "claude-opus-5", kenModelOverride: false });
  });

  it("plan_exit opens the human review modal when autopilot is off", () => {
    const { hook, getPlanReview } = setup(() => false, { autopilot: false });
    act(() => {
      hook.result.current.handleEvent(
        ev("plan_exit", { planPath: "/tmp/p.md", content: "# Plan" }),
      );
    });
    expect(getPlanReview()).toBe("# Plan");
  });

  it("plan_exit hides the human review modal when autopilot is on", () => {
    const { hook, getPlanReview, deps } = setup(() => false, { autopilot: true });
    act(() => {
      hook.result.current.handleEvent(
        ev("plan_exit", { planPath: "/tmp/p.md", content: "# Plan" }),
      );
    });
    // The content/path are still stashed for Ken auto-review + auto-accept step
    // counting, but the human overlay stays hidden while autopilot owns review.
    expect(getPlanReview()).toBeNull();
    expect(deps.planReviewPathRef.current).toBe("/tmp/p.md");
  });

  it("autopilot_plan_accepted seeds the plan step count and pushes the marker", () => {
    const { hook, deps, getItems } = setup();
    const plan =
      "# Plan\n\n## Steps\n\n1. Add the provider config module\n2. Wire the callback route";
    act(() => {
      // plan_exit stashes the plan content the accepted-frame reads.
      hook.result.current.handleEvent(ev("plan_exit", { planPath: "/tmp/p.md", content: plan }));
      hook.result.current.handleEvent(ev("autopilot_plan_accepted", {}));
    });
    // Step count seeded for the accept-driven session_reset to carry over.
    expect(deps.pendingPlanTotalRef.current).toBe(2);
    // The approved marker lands in the transcript (rendered as a Ken bubble).
    const marker = getItems().find((i) => i.kind === "autopilot");
    expect(marker).toMatchObject({ kind: "autopilot", phase: "plan_approved" });
  });

  it("uses sidecar plan progress as the authoritative live-file snapshot", () => {
    const { hook, deps } = setup();
    deps.planTotalRef.current = 2;
    deps.planDoneRef.current = new Set([1]);

    act(() => {
      hook.result.current.handleEvent(
        ev("plan_progress", { total: 4, completed: [1, 2, 4, 99, "3"] }),
      );
    });

    expect(deps.planTotalRef.current).toBe(4);
    expect([...deps.planDoneRef.current]).toEqual([1, 2, 4]);
  });

  it("seeds an accepted plan from the canonical total on session reset", () => {
    const { hook, deps } = setup();
    deps.pendingPlanTotalRef.current = 2;

    act(() => {
      hook.result.current.handleEvent(ev("session_reset", { planTotal: 5 }));
    });

    expect(deps.pendingPlanTotalRef.current).toBeNull();
    expect(deps.planTotalRef.current).toBe(5);
    expect(deps.planDoneRef.current.size).toBe(0);
  });

  it("autopilot_prompted closes the stale plan modal after Ken asks for revision", () => {
    const { hook, getPlanReview } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("plan_exit", { planPath: "/tmp/p.md", content: "# Plan" }),
      );
    });
    expect(getPlanReview()).toBe("# Plan");
    act(() => {
      hook.result.current.handleEvent(ev("autopilot_prompted", { round: 1, body: "revise it" }));
    });
    // Autopilot-only: a revision prompt means Ken took over the plan review;
    // the human modal should disappear. Non-autopilot never emits this frame.
    expect(getPlanReview()).toBeNull();
  });

  it("run_end clears completed plan progress and running state", () => {
    const { hook, deps, setRunning } = setup();
    deps.planTotalRef.current = 3;
    deps.planDoneRef.current = new Set([1, 2, 3]);

    act(() => {
      hook.result.current.handleEvent(ev("run_start"));
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
    });

    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(deps.planTotalRef.current).toBe(0);
    expect(deps.planDoneRef.current.size).toBe(0);
  });

  it("upserts persistent async agents by agent_id through idle and interrupted states", () => {
    const { hook, getItems } = setup();
    const base = {
      agent_id: "abcd1234",
      task_name: "scan auth",
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 10,
      turn_count: 0,
      tool_use_count: 0,
      token_usage: { input: 0, output: 0 },
    };
    act(() =>
      hook.result.current.handleEvent(ev("subagent_state", { ...base, state: "starting" })),
    );
    act(() =>
      hook.result.current.handleEvent(
        ev("subagent_state", {
          ...base,
          state: "completed",
          elapsed_ms: 30,
          tool_use_count: 2,
          token_usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
        }),
      ),
    );
    const groups = getItems().filter((item) => item.kind === "subagent_group");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.kind === "subagent_group" ? group.agents : []).toMatchObject([
      {
        toolCallId: "abcd1234",
        status: "idle",
        async: true,
        toolUseCount: 2,
        tokenUsage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
      },
    ]);
  });

  it("keeps late async snapshots attached to their original run group", () => {
    const { hook, getItems } = setup();
    const snapshot = (agentId: string, state: "starting" | "completed") => ({
      agent_id: agentId,
      task_name: agentId,
      state,
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 10,
      turn_count: 0,
      tool_use_count: 0,
      token_usage: { input: 0, output: 0 },
    });

    act(() => {
      hook.result.current.handleEvent(ev("run_start"));
      hook.result.current.handleEvent(ev("subagent_state", snapshot("old-agent", "starting")));
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
      hook.result.current.handleEvent(ev("run_start"));
      hook.result.current.handleEvent(ev("subagent_state", snapshot("new-agent", "starting")));
      hook.result.current.handleEvent(ev("subagent_state", snapshot("old-agent", "completed")));
    });

    const groups = getItems().filter((item) => item.kind === "subagent_group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind === "subagent_group" ? groups[0].agents : []).toMatchObject([
      { toolCallId: "old-agent", status: "idle" },
    ]);
    expect(groups[1]?.kind === "subagent_group" ? groups[1].agents : []).toMatchObject([
      { toolCallId: "new-agent", status: "starting" },
    ]);
  });
});
