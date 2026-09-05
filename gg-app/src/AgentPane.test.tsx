// @vitest-environment jsdom
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";
import type * as ToastModule from "./toast";
import type { RoadmapPhaseDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import type { NotesDocumentV3 } from "./notes-types";

HTMLElement.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

const nativeMocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(async () => vi.fn()),
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  setWindowTitle: vi.fn(),
  getDroppedPathInfo: vi.fn(async (paths: string[]) =>
    paths.map((path) => ({ path, isDir: path.endsWith("folder") })),
  ),
  modelsChanged: null as null | (() => void),
  modelsUnlisten: vi.fn(),
  onSessionReset: null as null | ((operationId?: string) => void),
  kenRunning: false,
  toast: vi.fn(),
  appUpdate: {
    phase: "idle",
    progressLines: [] as string[],
    localPatched: true,
    installLabel: "Update local fork",
    installTitle: "Build patched installer",
    statusMessage: null as string | null,
    install: vi.fn(async (_options?: { summarizeDecisions?: boolean }) => {}),
  },
  readDroppedFileAttachment: vi.fn(async (path: string) => ({
    path,
    name: "file.txt",
    mime: "text/plain",
    size: 4,
    data: "dGVzdA==",
  })),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: nativeMocks.onDragDropEvent }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: nativeMocks.openDialog,
  save: nativeMocks.saveDialog,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(async () => vi.fn()),
    setTitle: vi.fn(),
  }),
}));
vi.mock("./useKenMentor", () => ({
  useKenMentor: () => ({
    kenRunning: nativeMocks.kenRunning,
    kenTokens: 0,
    kenRunStartTs: null,
    kenIsThinking: false,
    kenThinkingStartTs: null,
    kenThinkingAccumMs: 0,
    handleKenEvent: vi.fn(),
  }),
}));
vi.mock("./useProgress", () => ({
  useProgress: () => ({ snapshot: null, levelUp: null, levelUpNonce: null, levelUpOrigin: false }),
}));
vi.mock("./useAgentEvents", () => ({
  HOOK_PRESENTATION: {},
  useAgentEvents: (deps: {
    handleAutopilotEvent: (event: AgentModule.SidecarEvent) => boolean;
    onSessionReset?: (operationId?: string) => void;
    onRoadmapPhaseDraftChange?: (draft: AgentModule.RoadmapPhaseDraftChangeEvent["data"]) => void;
    setItems: Dispatch<SetStateAction<Item[]>>;
    setPlanReview: Dispatch<SetStateAction<AgentModule.PendingPlanReview | null>>;
    planReviewPathRef: { current: string | null };
  }) => {
    nativeMocks.onSessionReset = deps.onSessionReset ?? null;
    const replacePlanReview = useCallback(
      (review: AgentModule.PendingPlanReview | null) => {
        deps.planReviewPathRef.current = review?.planPath ?? null;
        deps.setPlanReview(review);
      },
      [deps.planReviewPathRef, deps.setPlanReview],
    );
    return {
      handleEvent: (event: AgentModule.SidecarEvent) => {
        if (event.type === "roadmap_phase_draft_change") {
          deps.onRoadmapPhaseDraftChange?.(
            event.data as AgentModule.RoadmapPhaseDraftChangeEvent["data"],
          );
          return true;
        }
        if (event.type === "plan_exit") {
          const data = event.data as Record<string, unknown>;
          deps.planReviewPathRef.current = typeof data.planPath === "string" ? data.planPath : null;
          deps.setPlanReview({
            checkpointId:
              typeof data.checkpointId === "string" ? data.checkpointId : "checkpoint-1",
            generation: typeof data.generation === "number" ? data.generation : 1,
            planPath: deps.planReviewPathRef.current ?? "",
            content: String(data.content ?? ""),
            contentHash: "",
            state: "pending-review",
            reviewStatus: "unreviewed",
            feedback: null,
          });
          return true;
        }
        if (event.type !== "session_reset") return deps.handleAutopilotEvent(event);
        const data = event.data as { operationId?: unknown };
        deps.setItems([]);
        deps.onSessionReset?.(typeof data.operationId === "string" ? data.operationId : undefined);
      },
      pushItem: (item: Item) => deps.setItems((current) => [...current, item]),
      endStreamingText: vi.fn(),
      replacePlanReview,
    };
  },
}));
vi.mock("./HomeScreen", () => ({
  HomeScreen: (props: {
    onProjects?: () => void;
    waitForAgentReady?: () => Promise<unknown>;
    loadProgress?: () => Promise<unknown>;
  }) => (
    <div
      data-testid="home-screen"
      data-has-pane-ready={String(typeof props.waitForAgentReady === "function")}
      data-has-pane-progress={String(typeof props.loadProgress === "function")}
    >
      <button onClick={props.onProjects}>Open projects</button>
    </div>
  ),
}));
vi.mock("./ProjectPicker", () => ({
  ProjectPicker: (props: {
    bindProject: (cwd: string, sessionPath?: string) => Promise<unknown>;
    onChosen: (cwd: string) => void;
  }) => (
    <button
      onClick={() =>
        void Promise.resolve(props.bindProject("/chosen", "/chosen.jsonl")).then(() =>
          props.onChosen("/chosen"),
        )
      }
    >
      Bind project
    </button>
  ),
}));
vi.mock("./update", () => ({ useAppUpdate: () => nativeMocks.appUpdate }));
vi.mock("./build-info", () => ({
  formatBuildIdentity: () => "Supah Coder Local Fork · abc1234",
}));
vi.mock("./sounds", () => ({ playSound: vi.fn(), isSoundEnabled: () => true }));
vi.mock("./toast", async (importOriginal) => ({
  ...(await importOriginal<typeof ToastModule>()),
  toast: nativeMocks.toast,
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => null }));
vi.mock("./agent", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentModule>();
  return {
    ...actual,
    restoreTarget: vi.fn(async () => null),
    setWindowTitle: nativeMocks.setWindowTitle,
    onWindowOrder: vi.fn(async () => vi.fn()),
    onModelsChanged: vi.fn(async (callback: () => void) => {
      nativeMocks.modelsChanged = callback;
      return nativeMocks.modelsUnlisten;
    }),
    isSecondaryWindow: false,
    windowLabel: "main",
    createPaneAgentClient: vi.fn((paneId: string) => client(paneId, 1)),
    getDroppedPathInfo: nativeMocks.getDroppedPathInfo,
    readDroppedFileAttachment: nativeMocks.readDroppedFileAttachment,
  };
});

import {
  AgentPane,
  noInputSlashSubmissionError,
  preferredRoadmapPhaseSession,
  resolveRoadmapPhaseResume,
  resolveRoadmapPhaseResumeFromNotes,
} from "./AgentPane";
import { NewSessionError, PlanMutationError } from "./agent";
import type { Item, PaneInputActions, PaneSnapshot } from "./AgentPane";
import type {
  AgentState,
  PaneAgentClient,
  PaneSessionTarget,
  ProjectTask,
  SidecarEvent,
} from "./agent";

const target: PaneSessionTarget = { mode: "code", cwd: "/work", sessionPath: "/session" };
const chatTarget: PaneSessionTarget = {
  mode: "chat",
  chatAgent: "general",
  cwd: "/work",
  sessionPath: "/chat-session",
};
const roadmapDraft: RoadmapPhaseDraft = {
  id: "draft-research",
  projectKey: "/work",
  basedOnRevision: 12,
  createdAt: "2026-08-08T12:00:00.000Z",
  createdBySessionId: "research-session",
  summary: "Add the researched delivery phase.",
  references: [
    {
      id: "reference-1",
      provider: "github",
      tool: "code-search",
      canonicalUrl: "https://github.com/example/project/blob/abc123/src/research.ts",
      owner: "example",
      repo: "project",
      revision: "abc123",
      path: "src/research.ts",
      range: { startLine: 10, endLine: 24 },
      issue: null,
      pullRequest: null,
      query: null,
      anchor: null,
      relevance: "Supports the researched implementation boundary.",
    },
  ],
  phases: [
    {
      phaseId: "phase-research",
      title: "Implement researched workflow",
      goal: "Deliver the approved researched workflow without starting it.",
      doneWhen: ["The workflow is available for a later explicit start"],
      sourcePrompt: "Implement the researched workflow after approval.",
      referenceIds: ["reference-1"],
    },
  ],
  status: "pending",
};
const agentState = (model: string): AgentState => ({
  accountId: null,
  openAICodexContextProfile: "stable",
  openAICodexFast: false,
  contextTokens: 0,
  contextWindow: 200_000,
  provider: "azure",
  model,
  cwd: "/work",
  mode: "code",
  running: false,
});
const projectTask: ProjectTask = {
  id: "task-1",
  title: "Keep this task visible",
  prompt: "Preserve task state when requests fail",
  status: "pending",
  createdAt: "2026-09-04T00:00:00.000Z",
};
const KEN_PROMPT = "Implement the guarded session action\n  Preserve this indentation";
const CONTINUATION_PROMPT = `## Objective
Continue safely.

## Ken’s next instruction
${KEN_PROMPT}`;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function client(paneId: string, generation: number): PaneAgentClient {
  const empty = vi.fn(async () => []);
  return {
    paneId,
    create: vi.fn(async () => generation),
    restore: vi.fn(async () => generation),
    dispose: vi.fn(async () => {}),
    subscribe: vi.fn(() => vi.fn()),
    waitForReady: vi.fn(async () => ({ ready: true, error: null, generation, sessionId: paneId })),
    status: vi.fn(async () => ({ ready: true, error: null, generation, sessionId: paneId })),
    selectWorkspace: vi.fn(async () => generation),
    getState: vi.fn(async () => ({ running: false })),
    getNotes: vi.fn(async () => ({ status: "missing" as const })),
    getNotesDiagnostics: vi.fn(async () => ({
      version: 1 as const,
      applicationIdentity: "com.ggcoder.local-fork",
      daemonOwner: "node-sidecar" as const,
      agentDataRoot: "/tmp/agent",
      canonicalCwd: "/work",
      projectKey: "/work",
      projectNotesStore: {
        primaryPath: "/tmp/agent/project-notes/project.json",
        backupPath: "/tmp/agent/project-notes/project.backup.json",
      },
      logicalSessionId: paneId,
      currentSession: { sessionId: paneId, sessionPath: null },
      activePhaseContext: null,
      persistedPhaseBinding: null,
      consistency: "unbound" as const,
    })),
    bindRoadmapPhase: vi.fn(async () => ({ status: "missing" as const })),
    previewManualCompletionApproval: vi.fn(async () => ({ status: "missing" as const })),
    commitManualCompletionApproval: vi.fn(async () => ({ status: "nonce-not-found" as const })),
    migrateNotes: vi.fn(async (document: NotesDocumentV3) => ({
      status: "ok" as const,
      migrated: true,
      snapshot: { projectKey: "/work", revision: 1, document },
    })),
    saveNotes: vi.fn(async (expectedRevision: number, document: NotesDocumentV3) => ({
      status: "ok" as const,
      snapshot: { projectKey: "/work", revision: expectedRevision + 1, document },
    })),
    startPhase: vi.fn(),
    cancelPhaseRun: vi.fn(),
    getRoadmapPhaseDraft: vi.fn(async () => null),
    approveRoadmapPhaseDraft: vi.fn(),
    rejectRoadmapPhaseDraft: vi.fn(),
    listModels: empty,
    listCommands: empty,
    listTasks: empty,
    listHistory: empty,
    getProgress: vi.fn(async () => null),
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    listJiwa: vi.fn(),
    deleteJiwa: vi.fn(),
    getSubscriptionUsage: vi.fn(),
    enhancePrompt: vi.fn(),
    sendPrompt: vi.fn(async () => ({ queued: false, count: 0 })),
    prepareContinuationHandoff: vi.fn(async () => ({
      version: 1 as const,
      prompt: CONTINUATION_PROMPT,
    })),
    cancel: vi.fn(),
    sendKenPrompt: vi.fn(),
    cancelKen: vi.fn(),
    setAutopilot: vi.fn(),
    acceptPlan: vi.fn(async () => ({ ok: true, planTotal: 0, operationId: "plan-accept-1" })),
    revisePlan: vi.fn(async () => ({ ok: true, operationId: "plan-revise-1" })),
    authOAuthStart: vi.fn(),
    authOAuthCode: vi.fn(),
    newSession: vi.fn(async () => ({ operationId: "operation-1" })),
    getRadioState: vi.fn(),
    setRadio: vi.fn(),
    setRadioVolume: vi.fn(),
    runTask: vi.fn(),
    runAllTasks: vi.fn(),
    deleteTask: vi.fn(),
    killTask: vi.fn(),
    cycleThinking: vi.fn(),
    switchModel: vi.fn(),
    setOpenAICodexContextProfile: vi.fn(),
    setOpenAICodexFast: vi.fn(),
    switchKenModel: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    listProjects: vi.fn(),
    searchFiles: vi.fn(async () => []),
    listSessions: vi.fn(),
    getTelegramStatus: vi.fn(),
    saveTelegramConfig: vi.fn(),
    getServeStatus: vi.fn(),
    startServe: vi.fn(),
    stopServe: vi.fn(),
    listMcpServers: vi.fn(),
    addMcpServer: vi.fn(),
    loginMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
  } as unknown as PaneAgentClient;
}

async function renderKenPromptPane(
  pane: PaneAgentClient,
  running = false,
  prompt = KEN_PROMPT,
  onGenerationChange?: (generation: number) => void,
): Promise<HTMLButtonElement> {
  vi.mocked(pane.getState).mockResolvedValue({
    ...agentState("azure:gpt-test"),
    running,
    runState: running ? "running" : "idle",
  });
  vi.mocked(pane.listHistory).mockResolvedValue([
    {
      role: "assistant",
      text: `\`\`\`prompt\n${prompt}\n\`\`\``,
      ken: true,
    },
  ] as Awaited<ReturnType<PaneAgentClient["listHistory"]>>);
  render(<AgentPane client={pane} onGenerationChange={onGenerationChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
  fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
  return (await screen.findByRole("button", { name: "Continue here" })) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  nativeMocks.modelsChanged = null;
  nativeMocks.modelsUnlisten.mockReset();
  nativeMocks.onSessionReset = null;
  nativeMocks.kenRunning = false;
  nativeMocks.toast.mockReset();
  nativeMocks.appUpdate.phase = "idle";
  nativeMocks.appUpdate.localPatched = true;
  nativeMocks.appUpdate.install.mockReset();
  vi.useRealTimers();
});

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

  it("blocks reconciliation instead of returning a stale session while preserving Resume", () => {
    const stale = { sessionId: "planning", sessionPath: "/planning.jsonl" };
    const implementation = { sessionId: "implementation", sessionPath: "/implementation.jsonl" };

    const blocked = resolveRoadmapPhaseResume(
      {
        session: stale,
        execution: { state: "needs-reconciliation", lastSession: implementation },
      },
      stale,
    );
    expect(blocked).toEqual({
      status: "blocked",
      message:
        "Resume is blocked until this phase is reconciled. Open Project Notes, select Roadmap, then choose Reconcile.",
    });
    expect("session" in blocked).toBe(false);
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

async function openTasksModal(pane: PaneAgentClient): Promise<void> {
  vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
  render(<AgentPane client={pane} target={target} />);
  fireEvent.click(await screen.findByRole("button", { name: "Tasks (1)" }));
  await screen.findByRole("dialog", { name: "Tasks" });
}

describe("AgentPane task request failures", () => {
  it("keeps the current tasks visible when refreshing the list fails", async () => {
    const pane = client("pane-task-list-failure", 1);
    let rejectRefresh = false;
    vi.mocked(pane.listTasks).mockImplementation(async () => {
      if (rejectRefresh) throw new Error("task list unavailable");
      return [projectTask];
    });
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(<AgentPane client={pane} target={target} />);
    const tasksButton = await screen.findByRole("button", { name: "Tasks (1)" });

    rejectRefresh = true;
    fireEvent.click(tasksButton);

    await screen.findByRole("dialog", { name: "Tasks" });
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

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith("task cannot start", "error"),
    );
    expect(screen.getByText(projectTask.title)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeTruthy();
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
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeTruthy();
  });

  it("keeps the current tasks visible when delete is rejected", async () => {
    const pane = client("pane-task-delete-failure", 1);
    vi.mocked(pane.listTasks).mockResolvedValue([projectTask]);
    vi.mocked(pane.deleteTask).mockRejectedValue(new Error("task delete refused"));
    await openTasksModal(pane);

    fireEvent.click(screen.getByTitle("Delete task"));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith("task delete refused", "error"),
    );
    expect(screen.getByText(projectTask.title)).toBeTruthy();
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

describe("AgentPane lifecycle", () => {
  it("rehydrates a durable accessible MCP failure transcript row", async () => {
    const pane = client("pane-1", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    vi.mocked(pane.listHistory).mockResolvedValue([
      {
        role: "assistant",
        text: "",
        mcpToolFailure: {
          name: "mcp__acceptance__fixture_is_error",
          result: "fixture-is-error",
        },
      },
    ]);

    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);

    const failedRow = await screen.findByRole("status", {
      name: "Failed MCP tool: acceptance / fixture_is_error",
    });
    expect(failedRow.textContent).toContain("Failed");
    expect(failedRow.textContent).toContain("fixture-is-error");
  });

  it("shows context profiles only for GPT-6 Astra using Codex OAuth", async () => {
    const oauthPane = client("astra-oauth", 1);
    vi.mocked(oauthPane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextTokens: 136_000,
      contextWindow: 272_000,
    });
    const mounted = render(
      <AgentPane client={oauthPane} target={target} workspaceOwnsSessionLifecycle />,
    );
    expect(
      await screen.findByRole("combobox", { name: "OpenAI Codex context profile" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("switch", { name: /Fast (on|off) · 2.5× credits/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("136,000 / 272K · 50%")).toBeDefined();

    mounted.unmount();
    const apiKeyPane = client("astra-api-key", 1);
    vi.mocked(apiKeyPane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      openAICodexContextProfile: "stable",
      contextWindow: 1_050_000,
    });
    render(<AgentPane client={apiKeyPane} target={target} workspaceOwnsSessionLifecycle />);
    await screen.findAllByText("gpt-6-astra");
    expect(screen.queryByRole("combobox", { name: "OpenAI Codex context profile" })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Fast (on|off) · 2.5× credits/ })).toBeNull();
  });

  it("keeps Astra controls independent across panes", async () => {
    const left = client("astra-left", 1);
    const right = client("astra-right", 1);
    vi.mocked(left.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "left-account",
      openAICodexContextProfile: "stable",
      openAICodexFast: false,
      contextTokens: 136_000,
      contextWindow: 272_000,
    });
    vi.mocked(right.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "right-account",
      openAICodexContextProfile: "experimental",
      openAICodexFast: true,
      contextTokens: 300_000,
      contextWindow: 872_000,
    });

    render(
      <>
        <AgentPane client={left} target={target} workspaceOwnsSessionLifecycle />
        <AgentPane client={right} target={target} workspaceOwnsSessionLifecycle />
      </>,
    );
    const selectors = await screen.findAllByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    const fastSwitches = screen.getAllByRole("switch", { name: /Fast (on|off) · 2.5× credits/ });
    expect(selectors.map((selector) => (selector as HTMLSelectElement).value)).toEqual([
      "stable",
      "experimental",
    ]);
    expect(fastSwitches.map((button) => button.textContent)).toEqual([
      "Fast off · 2.5× credits",
      "Fast on · 2.5× credits",
    ]);
    expect(fastSwitches.map((button) => button.title)).toEqual([
      "Fast mode is off. Turn on to use Fast mode at 2.5× credits.",
      "Fast mode is on. Uses 2.5× credits. Click to turn off.",
    ]);
    expect(fastSwitches.map((button) => button.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
    ]);
    expect(screen.getByText("136,000 / 272K · 50%")).toBeDefined();
    expect(screen.getByText("300,000 / 872K · 34%")).toBeDefined();
  });

  it("disables the context profile selector while running", async () => {
    const pane = client("astra-running", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextWindow: 272_000,
      running: true,
    });
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    expect(
      (await screen.findByRole("combobox", {
        name: "OpenAI Codex context profile",
      })) as HTMLSelectElement,
    ).toMatchObject({ disabled: true });
  });

  it("disables Astra controls while Autopilot owns the session", async () => {
    const pane = client("astra-autopilot", 1);
    let emit: ((event: SidecarEvent) => void) | undefined;
    vi.mocked(pane.subscribe).mockImplementation((handler) => {
      emit = handler;
      return vi.fn();
    });
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextWindow: 272_000,
    });
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    const fast = screen.getByRole("switch", { name: /Fast (on|off) · 2.5× credits/ });

    act(() => emit?.({ type: "autopilot_review_start", data: {} }));
    await waitFor(() => expect(selector).toMatchObject({ disabled: true }));
    expect(fast).toMatchObject({ disabled: true });

    act(() => emit?.({ type: "autopilot_done", data: {} }));
    await waitFor(() => expect(selector).toMatchObject({ disabled: false }));
    expect(fast).toMatchObject({ disabled: false });
  });

  it("optimistically updates and settles a busy context profile", async () => {
    const pane = client("astra-switch", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextWindow: 272_000,
    });
    const mutation = deferred<{
      openAICodexContextProfile: "experimental";
      contextWindow: number;
    }>();
    vi.mocked(pane.setOpenAICodexContextProfile).mockReturnValue(mutation.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    const fast = screen.getByRole("switch", { name: /Fast (on|off) · 2.5× credits/ });
    fireEvent.change(selector, { target: { value: "experimental" } });
    expect((selector as HTMLSelectElement).value).toBe("experimental");
    expect(selector).toMatchObject({ disabled: true });
    expect(fast).toMatchObject({ disabled: true });
    await waitFor(() =>
      expect(pane.setOpenAICodexContextProfile).toHaveBeenCalledWith("experimental"),
    );
    mutation.resolve({ openAICodexContextProfile: "experimental", contextWindow: 872_000 });
    await waitFor(() => expect(selector).toMatchObject({ disabled: false }));
  });

  it("optimistically settles and rolls back Fast mutations", async () => {
    const pane = client("astra-fast", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      openAICodexFast: false,
      contextWindow: 272_000,
    });
    const mutation = deferred<{ openAICodexFast: boolean }>();
    vi.mocked(pane.setOpenAICodexFast).mockReturnValueOnce(mutation.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const fast = await screen.findByRole("switch", { name: /Fast (on|off) · 2.5× credits/ });
    const selector = screen.getByRole("combobox", { name: "OpenAI Codex context profile" });

    fireEvent.click(fast);
    expect(fast.getAttribute("aria-checked")).toBe("true");
    expect(fast.textContent).toBe("Fast on · 2.5× credits");
    expect(fast).toMatchObject({ disabled: true });
    expect(pane.setOpenAICodexFast).toHaveBeenCalledWith(true);
    expect(selector).toMatchObject({ disabled: true });
    mutation.resolve({ openAICodexFast: true });
    await waitFor(() => expect(selector).toMatchObject({ disabled: false }));

    vi.mocked(pane.setOpenAICodexFast).mockRejectedValueOnce(new Error("Fast unavailable"));
    fireEvent.click(fast);
    await waitFor(() => expect(fast.getAttribute("aria-checked")).toBe("true"));
    expect(nativeMocks.toast).toHaveBeenCalledWith("Fast unavailable", "error");
    expect(pane.setOpenAICodexFast).toHaveBeenLastCalledWith(false);
    expect(fast.textContent).toBe("Fast on · 2.5× credits");
  });

  it("preserves newer authoritative state when a profile mutation fails", async () => {
    const pane = client("astra-stale", 1);
    let emit: ((event: SidecarEvent) => void) | undefined;
    vi.mocked(pane.subscribe).mockImplementation((handler) => {
      emit = handler;
      return vi.fn();
    });
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
      openAICodexFast: false,
      contextWindow: 872_000,
    });
    const mutation = deferred<{
      openAICodexContextProfile: "stable" | "experimental";
      contextWindow: number;
    }>();
    vi.mocked(pane.setOpenAICodexContextProfile).mockReturnValue(mutation.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    fireEvent.change(selector, { target: { value: "stable" } });
    await waitFor(() => expect(emit).toBeDefined());
    act(() =>
      emit?.({
        type: "context_profile_change",
        data: { openAICodexContextProfile: "stable", contextWindow: 272_000 },
      }),
    );
    mutation.reject(new Error("stale refusal"));

    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe("stable"));
  });

  it("displays a refused context-profile change without mutating the selector", async () => {
    const pane = client("astra-refusal", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
      contextWindow: 872_000,
    });
    vi.mocked(pane.setOpenAICodexContextProfile).mockRejectedValue(
      new Error("Compact or start a new session first."),
    );
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    fireEvent.change(selector, { target: { value: "stable" } });
    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith(
        "Compact or start a new session first.",
        "error",
      ),
    );
    expect((selector as HTMLSelectElement).value).toBe("experimental");
  });

  it("wires the restored home UI through the pane-scoped catalog client", async () => {
    const pane = client("primary", 1);
    render(<AgentPane client={pane} />);

    await waitFor(() =>
      expect(document.querySelector('[data-testid="home-screen"]')).not.toBeNull(),
    );
    const home = document.querySelector('[data-testid="home-screen"]');
    expect(home?.getAttribute("data-has-pane-ready")).toBe("true");
    expect(home?.getAttribute("data-has-pane-progress")).toBe("true");
    expect(pane.create).not.toHaveBeenCalled();
  });

  it("renders the local-build identity in the agent footer", async () => {
    const pane = client("pane-1", 1);
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    expect((await screen.findByText("◆ Supah Coder Local Fork · abc1234")).className).toBe(
      "footer-custom-build",
    );
  });

  it("presents the compatible general chat agent as Brainstorm", async () => {
    const pane = client("pane-brainstorm", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      mode: "chat",
      chatAgent: "general",
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);

    expect(await screen.findByText("Brainstorm")).toBeDefined();
    expect(screen.queryByText("General Agent")).toBeNull();
  });

  it("adopts a switched pane generation before the next selection", async () => {
    const pane = client("pane-1", 3);
    vi.mocked(pane.selectWorkspace).mockResolvedValueOnce(4).mockResolvedValueOnce(5);
    vi.mocked(pane.waitForReady).mockResolvedValue({
      ready: true,
      error: null,
      generation: 4,
      sessionId: "pane-1",
    });
    const onUserTargetChange = vi.fn();
    const onGenerationChange = vi.fn();
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
        onUserTargetChange={onUserTargetChange}
        onGenerationChange={onGenerationChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));

    await waitFor(() => expect(onGenerationChange).toHaveBeenCalledWith(4));
    fireEvent.click(await screen.findByRole("button", { name: /Back to this project's sessions/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));

    await waitFor(() =>
      expect(pane.selectWorkspace).toHaveBeenLastCalledWith(
        { mode: "code", cwd: "/chosen", sessionPath: "/chosen.jsonl" },
        4,
      ),
    );
    expect(onGenerationChange).toHaveBeenCalledWith(5);
    expect(onUserTargetChange).toHaveBeenCalledTimes(2);
  });

  it("reloads and replaces the pane model catalog after a native refresh", async () => {
    const pane = client("pane-1", 1);
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "azure:gpt-old", name: "Azure old", provider: "azure" },
    ]);
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    vi.mocked(pane.listModels).mockClear().mockResolvedValue([]);
    vi.mocked(pane.waitForReady).mockClear();

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(pane.listModels).toHaveBeenCalledOnce());
    expect(pane.waitForReady).toHaveBeenCalledOnce();
  });

  it("closes an open model menu even when the refreshed catalog compares equal", async () => {
    const pane = client("pane-1", 1);
    const catalog = [{ id: "azure:gpt-old", name: "Azure old", provider: "azure" }];
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-old"));
    vi.mocked(pane.listModels).mockResolvedValue(catalog);
    const view = render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const modelButton = await screen.findByTitle("Switch Supah Coder's model");
    await waitFor(() => expect((modelButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(modelButton);
    expect(screen.getByRole("menu", { name: "Switch Supah Coder's model" })).toBeTruthy();

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Switch Supah Coder's model" })).toBeNull(),
    );
    view.unmount();
    await waitFor(() => expect(nativeMocks.modelsUnlisten).toHaveBeenCalledOnce());
  });

  it("adopts the recovered generation after daemon respawn", async () => {
    const pane = client("pane-1", 1);
    const onGenerationChange = vi.fn();
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-old"));
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "azure:gpt-old", name: "Azure old", provider: "azure" },
    ]);
    render(<AgentPane client={pane} onGenerationChange={onGenerationChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const modelButton = await screen.findByTitle("Switch Supah Coder's model");
    await waitFor(() => expect(modelButton.textContent).toContain("Azure old"));
    onGenerationChange.mockClear();
    vi.mocked(pane.waitForReady).mockResolvedValue({
      ready: true,
      error: null,
      generation: 2,
      sessionId: "pane-1",
    });
    vi.mocked(pane.getState).mockReset().mockResolvedValue(agentState("azure:gpt-new"));
    vi.mocked(pane.listModels)
      .mockReset()
      .mockResolvedValue([{ id: "azure:gpt-new", name: "Azure new", provider: "azure" }]);

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(onGenerationChange).toHaveBeenCalledWith(2));
    expect(screen.getByTitle("Switch Supah Coder's model").textContent).toContain("Azure new");
  });

  it("separate pane clients create and subscribe independently", async () => {
    const left = client("left", 1),
      right = client("right", 2);
    const view = render(
      <>
        <AgentPane client={left} target={target} />
        <AgentPane client={right} target={target} />
      </>,
    );
    await waitFor(() => expect(left.create).toHaveBeenCalledWith(target));
    expect(right.create).toHaveBeenCalledWith(target);
    expect(left.subscribe).toHaveBeenCalled();
    expect(right.subscribe).toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(left.dispose).toHaveBeenCalledWith(1));
    expect(right.dispose).toHaveBeenCalledWith(2);
  });

  it("reports autopilot review as active work until a terminal autopilot event", async () => {
    const pane = client("pane-1", 7);
    const onSnapshot = vi.fn<(snapshot: PaneSnapshot) => void>();
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        target={target}
        workspaceOwnsSessionLifecycle
        onSnapshot={onSnapshot}
      />,
    );
    await waitFor(() => {
      expect(pane.subscribe).toHaveBeenCalled();
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ paneId: "pane-1", activeWork: false }),
      );
    });
    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];
    expect(handleEvent).toBeDefined();

    act(() => handleEvent?.({ type: "autopilot_review_start", data: {} }));
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ paneId: "pane-1", activeWork: true }),
      ),
    );

    act(() => handleEvent?.({ type: "autopilot_done", data: {} }));
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ paneId: "pane-1", activeWork: false }),
      ),
    );
  });

  it("hydrates a pending Roadmap draft in chat and keeps it reopenable after close", async () => {
    const pane = client("pane-chat-hydration", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);

    expect(await screen.findByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(pane.getRoadmapPhaseDraft).toHaveBeenCalledOnce();
    const trigger = screen.getByRole("button", {
      name: "Review Roadmap draft with 1 proposed phase",
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(trigger).toBeTruthy();

    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(pane.approveRoadmapPhaseDraft).not.toHaveBeenCalled();
    expect(pane.rejectRoadmapPhaseDraft).not.toHaveBeenCalled();
  });

  it("opens and exposes Roadmap drafts received live in chat", async () => {
    const pane = client("pane-chat-live-draft", 7);
    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.getRoadmapPhaseDraft).toHaveBeenCalledOnce());
    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];

    act(() =>
      handleEvent?.({
        type: "roadmap_phase_draft_change",
        data: roadmapDraft,
      }),
    );

    expect(await screen.findByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
  });

  it("discovers /research and carries its submission into pending draft review", async () => {
    const pane = client("pane-chat-research-command", 7);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "research",
        aliases: [],
        description: "Research this conversation and draft net-new Roadmap phases",
        input: { text: "optional", references: "optional", attachments: "optional" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const input = await screen.findByRole("textbox");

    fireEvent.change(input, { target: { value: "/res" } });
    expect(await screen.findByText("/research")).toBeTruthy();
    expect(
      screen.getByText("Research this conversation and draft net-new Roadmap phases"),
    ).toBeTruthy();

    const command = "/research approval UX";
    fireEvent.change(input, { target: { value: command } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(command, [], undefined));

    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];
    act(() =>
      handleEvent?.({
        type: "roadmap_phase_draft_change",
        data: roadmapDraft,
      }),
    );

    expect(await screen.findByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
  });

  it("surfaces prompt submission failures in the transcript", async () => {
    const pane = client("pane-prompt-failure", 7);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("plan approval handoff failed"));
    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    const input = await screen.findByRole("textbox");

    fireEvent.change(input, { target: { value: "continue after the plan" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("plan approval handoff failed")).toBeTruthy();
  });

  it("approves a chat Roadmap draft without starting implementation or a coding session", async () => {
    const pane = client("pane-chat-approve", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);
    vi.mocked(pane.approveRoadmapPhaseDraft).mockResolvedValue({
      status: "created",
      revision: 13,
      phaseIds: ["phase-research"],
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    fireEvent.click(await screen.findByRole("button", { name: "Create phases with references" }));

    await waitFor(() =>
      expect(pane.approveRoadmapPhaseDraft).toHaveBeenCalledWith("draft-research"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeNull();
    expect(pane.startPhase).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.acceptPlan).not.toHaveBeenCalled();
  });

  it("rejects and discards a chat Roadmap draft without starting other workflows", async () => {
    const pane = client("pane-chat-reject", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);
    vi.mocked(pane.rejectRoadmapPhaseDraft).mockResolvedValue({ status: "rejected" });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject draft" }));

    await waitFor(() =>
      expect(pane.rejectRoadmapPhaseDraft).toHaveBeenCalledWith("draft-research"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeNull();
    expect(pane.startPhase).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.acceptPlan).not.toHaveBeenCalled();
  });

  it("shows stale chat drafts without allowing approval", async () => {
    const pane = client("pane-chat-stale", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue({
      ...roadmapDraft,
      status: "stale",
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);

    expect((await screen.findByRole("alert")).textContent).toContain("This draft is out of date.");
    expect(
      (
        screen.getByRole("button", {
          name: "Create phases with references",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
  });

  it("keeps a chat draft reviewable when approval fails", async () => {
    const pane = client("pane-chat-approval-error", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);
    vi.mocked(pane.approveRoadmapPhaseDraft).mockRejectedValue(
      new Error("approval transport failed"),
    );

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    fireEvent.click(await screen.findByRole("button", { name: "Create phases with references" }));

    expect((await screen.findByRole("alert")).textContent).toContain("approval transport failed");
    expect(screen.getByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
    expect(pane.startPhase).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("preserves coding-mode Roadmap draft hydration and review", async () => {
    const pane = client("pane-code-draft", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);

    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);

    expect(await screen.findByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(pane.getRoadmapPhaseDraft).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("shows an approval draft after an unqualified natural-language Roadmap request", async () => {
    const pane = client("pane-roadmap-intent", 7);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.selectWorkspace).toHaveBeenCalled());
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    const input = await screen.findByRole("textbox");

    const request = "Add release hardening to our roadmap.";
    fireEvent.change(input, { target: { value: request } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(request, [], undefined));

    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];
    act(() =>
      handleEvent?.({
        type: "roadmap_phase_draft_change",
        data: {
          id: "draft-intent-proof",
          projectKey: "/work",
          basedOnRevision: 8,
          createdAt: "2026-08-05T12:00:00.000Z",
          createdBySessionId: "pane-roadmap-intent",
          summary: "Add release hardening without duplicating existing delivery work.",
          phases: [
            {
              phaseId: "phase-release-hardening",
              title: "Release hardening",
              goal: "Prove the release is safe to ship and recover.",
              doneWhen: ["Critical release checks pass", "Rollback is rehearsed"],
              sourcePrompt: request,
            },
          ],
          status: "pending",
        },
      }),
    );

    expect(await screen.findByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.getByText("Proposed from Project Notes revision 8")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Release hardening" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create phase" })).toBeTruthy();
  });

  it.each([
    ["selection", "C:\\picked"],
    ["cancellation", null],
  ] as const)("restores composer focus after add-dir picker %s", async (_outcome, selected) => {
    const pane = client("pane-add-dir-focus", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "add-dir",
        aliases: [],
        description: "Add project folder",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    const picker = deferred<string | null>();
    nativeMocks.openDialog.mockReturnValueOnce(picker.promise);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    input.focus();

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.click(await screen.findByText("/add-dir"));
    await waitFor(() => expect(nativeMocks.openDialog).toHaveBeenCalledOnce());
    expect(document.activeElement).not.toBe(input);

    await act(async () => picker.resolve(selected));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(pane.sendPrompt).toHaveBeenCalledTimes(selected === null ? 0 : 1);
  });

  it.each(["add-dir", "remove-dir"])(`reports failed /%s picker submissions`, async (name) => {
    const pane = client(`pane-${name}-failure`, 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name,
        aliases: [],
        description: "Change workspace folders",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("agent_prompt failed"));
    nativeMocks.openDialog.mockResolvedValueOnce("C:\\picked");
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    input.focus();

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.click(await screen.findByText(`/${name}`));

    expect(await screen.findByText("Prompt wasn’t sent")).toBeTruthy();
    expect(await screen.findByText("agent_prompt failed")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it.each(["add-dir", "remove-dir"])(`rejects staged inputs for typed /%s`, (name) => {
    expect(
      noInputSlashSubmissionError(
        `/${name} C:\\typed`,
        [
          {
            name,
            aliases: [],
            description: "Change workspace folders",
            input: { text: "optional", references: "none", attachments: "none" },
            source: "built-in",
          },
        ],
        1,
        1,
      ),
    ).toBe(
      `/${name} does not accept file references, attachments. Remove them and send the command again.`,
    );
  });

  it.each(["add-dir", "remove-dir"])(
    `clears staged inputs before opening the /%s picker`,
    async (name) => {
      const pane = client(`pane-${name}-inputs`, 8);
      vi.mocked(pane.listCommands).mockResolvedValue([
        {
          name,
          aliases: [],
          description: "Change workspace folders",
          input: { text: "optional", references: "none", attachments: "none" },
          source: "built-in",
        },
      ]);
      vi.mocked(pane.searchFiles).mockResolvedValue([
        { path: "src/context.ts", name: "context.ts" },
      ]);
      const picker = deferred<string | null>();
      nativeMocks.openDialog.mockReturnValueOnce(picker.promise);
      const actionsRef: { current: PaneInputActions | null } = { current: null };
      render(
        <AgentPane
          client={pane}
          target={target}
          registerInput={(_paneId, actions) => {
            actionsRef.current = actions;
          }}
        />,
      );
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());

      fireEvent.change(input, { target: { value: "@context" } });
      await waitFor(() => expect(pane.searchFiles).toHaveBeenCalledWith("context"));
      fireEvent.click(await screen.findByText("context.ts"));
      expect(await screen.findByRole("button", { name: "Remove src/context.ts" })).toBeTruthy();
      await act(async () => {
        actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]);
        await Promise.resolve();
      });
      expect(await screen.findByRole("button", { name: "Remove file.txt" })).toBeTruthy();
      act(() => actionsRef.current?.setNativeFileDragOver(true));
      expect(document.querySelector(".inputwrap.dragover")).not.toBeNull();

      fireEvent.change(input, { target: { value: "/" } });
      fireEvent.click(await screen.findByText(`/${name}`));
      await waitFor(() => expect(nativeMocks.openDialog).toHaveBeenCalledOnce());

      expect(screen.queryByRole("button", { name: "Remove src/context.ts" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove file.txt" })).toBeNull();
      expect(document.querySelector(".inputwrap.dragover")).toBeNull();
      expect((input as HTMLTextAreaElement).value).toBe("");
      expect(pane.sendPrompt).not.toHaveBeenCalled();

      await act(async () => picker.resolve("C:\\picked"));
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(`/${name} C:\\picked`));
    },
  );

  it("inserts fixed-input commands exactly and disables composer additions", async () => {
    const pane = client("pane-no-input-select", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "programmatic",
        aliases: [],
        description: "Scan programmatic opportunities",
        input: { text: "none", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.click(await screen.findByText("/programmatic"));

    expect((input as HTMLTextAreaElement).value).toBe("/programmatic");
    expect((input as HTMLTextAreaElement).readOnly).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("/programmatic", [], undefined),
    );
  });

  it("blocks malformed fixed-input submissions with actionable guidance", async () => {
    const pane = client("pane-no-input-submit", 9);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "programmatic",
        aliases: [],
        description: "Scan programmatic opportunities",
        input: { text: "none", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "/programmatic caller instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Command input blocked")).toBeTruthy();
    expect(screen.getByText(/does not accept additional text/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("/programmatic");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each([
    [
      "arguments",
      "/programmatic caller instructions",
      { text: "none", references: "optional", attachments: "optional" } as const,
      0,
      0,
      "additional text",
    ],
    [
      "attachments",
      "/programmatic",
      { text: "optional", references: "optional", attachments: "none" } as const,
      1,
      0,
      "attachments",
    ],
    [
      "referenced files",
      "/programmatic",
      { text: "optional", references: "none", attachments: "optional" } as const,
      0,
      1,
      "file references",
    ],
  ])(
    "independently rejects fixed-input submission %s",
    (_kind, text, inputPolicy, attachments, references, expected) => {
      expect(
        noInputSlashSubmissionError(
          text,
          [
            {
              name: "programmatic",
              aliases: [],
              description: "Scan",
              input: inputPolicy,
              source: "built-in",
            },
          ],
          attachments,
          references,
        ),
      ).toContain(expected);
    },
  );

  it("rehydrates a persisted plan review before any SSE event", async () => {
    const pane = client("pane-plan-restart", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-restart",
        generation: 5,
        planPath: "/plans/restart.md",
        content: "## Steps\n1. Verify restart hydration",
        contentHash: "hash",
        state: "pending-review",
        reviewStatus: "ready",
        feedback: null,
      },
    });
    render(<AgentPane client={pane} target={target} />);

    expect(await screen.findByText(/Your approval is still required/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-restart", 5));
  });

  it("replaces a stale accepted checkpoint with the backend checkpoint", async () => {
    const pane = client("pane-plan-stale-accept", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-old",
        generation: 2,
        planPath: "/plans/old.md",
        content: "## Old plan",
        contentHash: "old-hash",
        state: "pending-review",
        reviewStatus: "unreviewed",
        feedback: null,
      },
    });
    const latest = {
      checkpointId: "checkpoint-latest",
      generation: 3,
      planPath: "/plans/latest.md",
      content: "## Latest backend plan",
      contentHash: "latest-hash",
      state: "pending-review" as const,
      reviewStatus: "ready" as const,
      feedback: null,
    };
    vi.mocked(pane.acceptPlan).mockRejectedValue(
      new PlanMutationError(
        "The plan changed before this action completed. Review the latest checkpoint and try again.",
        { error: "stale-plan-checkpoint", pendingPlanReview: latest },
      ),
    );
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Latest backend plan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Review the latest checkpoint"),
      "error",
      7_000,
    );
  });

  it("replaces a stale revision request with the backend checkpoint", async () => {
    const pane = client("pane-plan-stale-revise", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-old",
        generation: 4,
        planPath: "/plans/old.md",
        content: "## Old revision target",
        contentHash: "old-hash",
        state: "pending-review",
        reviewStatus: "unreviewed",
        feedback: null,
      },
    });
    const latest = {
      checkpointId: "checkpoint-latest",
      generation: 5,
      planPath: "/plans/latest.md",
      content: "## Latest revision target",
      contentHash: "latest-hash",
      state: "revision-requested" as const,
      reviewStatus: "ready" as const,
      feedback: "Preserve the recovery contract",
    };
    vi.mocked(pane.revisePlan).mockRejectedValue(
      new PlanMutationError(
        "The plan changed before this action completed. Review the latest checkpoint and try again.",
        { error: "stale-plan-checkpoint", pendingPlanReview: latest },
      ),
    );
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Feedback" }));
    fireEvent.change(screen.getByPlaceholderText("What should change about this plan?"), {
      target: { value: "Revise this plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByText("Latest revision target")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry revision" })).toBeTruthy();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Review the latest checkpoint"),
      "error",
      7_000,
    );
  });

  it("keeps the gate open and shows actionable checkpoint failure guidance", async () => {
    const pane = client("pane-plan-checkpoint-failure", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-failure",
        generation: 7,
        planPath: "/plans/failure.md",
        content: "## Plan remains authoritative",
        contentHash: "failure-hash",
        state: "pending-review",
        reviewStatus: "ready",
        feedback: null,
      },
    });
    vi.mocked(pane.acceptPlan).mockRejectedValue(
      new PlanMutationError(
        "Could not persist the phase checkpoint. Fix Project Notes permissions, then retry.",
        {
          status: "failed",
          operationId: "operation-7",
          code: "checkpoint-write-failed",
          message: "Could not persist the phase checkpoint.",
          guidance: "Fix Project Notes permissions, then retry.",
          retryable: true,
          phaseId: "phase-1",
        },
      ),
    );
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith(
        "Could not persist the phase checkpoint. Fix Project Notes permissions, then retry.",
        "error",
        7_000,
      ),
    );
    expect(screen.getByText("Plan remains authoritative")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("retries the exact persisted revision after restart while prompts stay blocked", async () => {
    const pane = client("pane-plan-revision-retry", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-revision-retry",
        generation: 6,
        planPath: "/plans/retry.md",
        content: "## Steps\n1. Recover the revision run",
        contentHash: "hash",
        state: "revision-requested",
        reviewStatus: "ready",
        feedback: "Add crash recovery coverage",
      },
    });
    render(<AgentPane client={pane} target={target} />);

    expect(await screen.findByRole("button", { name: "Retry revision" })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry revision" }));
    await waitFor(() =>
      expect(pane.revisePlan).toHaveBeenCalledWith(
        "checkpoint-revision-retry",
        6,
        "Add crash recovery coverage",
      ),
    );
  });

  it("sends checkpoint identity for ordinary plan acceptance without a prompt bypass", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.acceptPlan).mockResolvedValue({
      ok: true,
      planTotal: 2,
      operationId: "plan-accept-test",
    });
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false),
    );
    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];

    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: {
          checkpointId: "checkpoint-ordinary",
          generation: 4,
          planPath: "/plans/ordinary.md",
          content: "## Steps\n1. Build\n2. Verify",
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-ordinary", 4));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("holds an implemented /commit action at the inline plan gate, then resumes after approval", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.acceptPlan).mockResolvedValue({
      ok: true,
      planTotal: 2,
      operationId: "plan-accept-test",
    });

    const continueButton = await renderKenPromptPane(pane, false, "/commit");
    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];
    fireEvent.click(continueButton);
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("/commit", [], { kenSent: true }),
    );
    vi.mocked(pane.sendPrompt).mockClear();

    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: {
          checkpointId: "checkpoint-commit",
          generation: 2,
          planPath: "/plans/blocked-commit.md",
          content: "## Steps\n1. Build\n2. Verify",
        },
      }),
    );

    expect(await screen.findByRole("region", { name: "Plan approval required" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(continueButton);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-commit", 2));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Plan approval required" })).toBeNull();
  });

  it("keeps the active approval-resume prompt when later steering is queued", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "assistant", text: "```prompt\n/commit\n```", ken: true },
      { role: "assistant", text: "```prompt\nqueued steering\n```", ken: true },
    ] as Awaited<ReturnType<PaneAgentClient["listHistory"]>>);
    vi.mocked(pane.sendPrompt)
      .mockResolvedValueOnce({ queued: false, count: 0 })
      .mockResolvedValueOnce({ queued: true, count: 1 });
    vi.mocked(pane.acceptPlan).mockResolvedValue({
      ok: true,
      planTotal: 2,
      operationId: "plan-accept-test",
    });

    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    const continueButtons = await screen.findAllByRole("button", { name: "Continue here" });
    fireEvent.click(continueButtons[0]!);
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("/commit", [], { kenSent: true }),
    );
    fireEvent.click(continueButtons[1]!);
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("queued steering", [], { kenSent: true }),
    );
    vi.mocked(pane.sendPrompt).mockClear();

    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];
    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: {
          checkpointId: "checkpoint-active",
          generation: 3,
          planPath: "/plans/active-commit.md",
          content: "## Steps\n1. Commit",
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-active", 3));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("managed panes restore an existing native session without owning its disposal", async () => {
    const pane = client("pane-1", 7);
    const view = render(
      <AgentPane
        client={pane}
        target={target}
        workspaceOwnsSessionLifecycle
        reclaimNativeSession
      />,
    );
    await waitFor(() => expect(pane.restore).toHaveBeenCalledWith(target));
    expect(pane.create).not.toHaveBeenCalled();
    view.unmount();
    expect(pane.dispose).not.toHaveBeenCalled();
  });

  it("does not restart or dispose when generation callback updates parent", async () => {
    const pane = client("pane-1", 7);
    function Harness() {
      const [generation, setGeneration] = useState<number | null>(null);
      return (
        <AgentPane
          client={pane}
          target={target}
          generation={generation}
          onGenerationChange={setGeneration}
        />
      );
    }
    const view = render(<Harness />);
    await waitFor(() => expect(pane.create).toHaveBeenCalledTimes(1));
    expect(pane.restore).not.toHaveBeenCalled();
    expect(pane.dispose).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(pane.dispose).toHaveBeenCalledWith(7));
  });

  it("disposes each generation it owns across a target replacement", async () => {
    const pane = client("pane-1", 9);
    vi.mocked(pane.restore).mockResolvedValueOnce(10);
    const nextTarget = { ...target, sessionPath: "/next" };
    const view = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.create).toHaveBeenCalledWith(target));
    view.rerender(<AgentPane client={pane} target={nextTarget} generation={10} />);
    await waitFor(() => expect(pane.dispose).toHaveBeenCalledWith(9));
    expect(pane.restore).toHaveBeenCalledWith(nextTarget);

    view.unmount();
    await waitFor(() => expect(pane.dispose).toHaveBeenCalledWith(10));
  });

  it("reports failed restore and remains recoverable after a target change", async () => {
    const pane = client("pane-1", 9);
    vi.mocked(pane.restore).mockRejectedValueOnce(new Error("restore failed"));
    const onError = vi.fn();
    const view = render(
      <AgentPane client={pane} target={target} generation={4} onLifecycleError={onError} />,
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(pane.dispose).not.toHaveBeenCalled();
    const recoverTarget = { ...target, sessionPath: null };
    view.rerender(
      <AgentPane client={pane} target={recoverTarget} generation={4} onLifecycleError={onError} />,
    );
    await waitFor(() => expect(pane.restore).toHaveBeenCalledWith(recoverTarget));
  });

  it.each(["@Supah question", "@Ken question"])(
    "routes %s to the mentor client",
    async (prompt) => {
      const pane = client("pane-1", 1);
      render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.selectWorkspace).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: prompt } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(pane.sendKenPrompt).toHaveBeenCalledWith("question"));
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("sends the Ken next quick action directly and adds a Ken-addressed bubble", async () => {
    const pane = client("pane-ken-next", 1);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Ken, next?" }));

    await waitFor(() => expect(pane.sendKenPrompt).toHaveBeenCalledWith("next?"));
    expect(pane.sendKenPrompt).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(document.querySelector(".user-msg.user-ken")?.textContent).toBe("@Ken next?");
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

    await waitFor(() => expect(pane.sendKenPrompt).toHaveBeenCalledWith("next?"));
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
    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];

    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: { planPath: "/plans/next.md", content: "## Steps\n1. Continue" },
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

  it("queues a Ken current-send during an active run with authoritative queue metadata", async () => {
    const pane = client("pane-ken-queued", 1);
    vi.mocked(pane.sendPrompt).mockResolvedValueOnce({ queued: true, count: 2 });
    const send = await renderKenPromptPane(pane, true);

    fireEvent.click(send);

    await waitFor(() => expect(document.querySelector(".user-ken-sent.queued")).not.toBeNull());
    expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true });
    expect(document.querySelector(".queued-pill")?.textContent).toBe("queued");
  });

  it("adopts the new-session ready generation and handles reset-before-response once", async () => {
    const pane = client("pane-ken-fresh", 1);
    const creation = deferred<Awaited<ReturnType<PaneAgentClient["newSession"]>>>();
    vi.mocked(pane.newSession).mockReturnValueOnce(creation.promise);
    const onGenerationChange = vi.fn();
    await renderKenPromptPane(pane, false, KEN_PROMPT, onGenerationChange);
    onGenerationChange.mockClear();
    vi.mocked(pane.waitForReady).mockResolvedValue({
      ready: true,
      error: null,
      generation: 2,
      sessionId: "pane-ken-fresh",
    });
    const fresh = screen.getByRole("button", { name: "New session" });

    fireEvent.click(fresh);
    fireEvent.click(fresh);
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledOnce());
    expect(pane.prepareContinuationHandoff).toHaveBeenCalledWith(KEN_PROMPT);
    expect(pane.prepareContinuationHandoff).toHaveBeenCalledOnce();
    expect(vi.mocked(pane.prepareContinuationHandoff).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(pane.newSession).mock.invocationCallOrder[0],
    );
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    act(() => nativeMocks.onSessionReset?.("unrelated-operation"));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    act(() => nativeMocks.onSessionReset?.("operation-1"));
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    await act(async () => creation.resolve({ operationId: "operation-1" }));
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(CONTINUATION_PROMPT, [], { kenSent: true }),
    );
    expect(onGenerationChange).toHaveBeenCalledWith(2);
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    expect(vi.mocked(pane.newSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(pane.sendPrompt).mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["provider failure", new Error("provider unavailable")],
    ["malformed synthesis", new Error("invalid continuation-handoff response")],
  ])("fails closed before reset on %s", async (_label, error) => {
    const pane = client("pane-ken-prepare-failure", 1);
    vi.mocked(pane.prepareContinuationHandoff).mockRejectedValueOnce(error);
    await renderKenPromptPane(pane);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("current session is unchanged");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.querySelector(".ken-prompt-body")?.textContent).toBe(KEN_PROMPT);
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps the old prompt card retryable after a known creation rejection", async () => {
    const pane = client("pane-ken-rejected", 1);
    vi.mocked(pane.newSession).mockRejectedValueOnce(
      new NewSessionError("creation-rejected", "HTTP 409", 409),
    );
    await renderKenPromptPane(pane);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("current session is unchanged");
    expect(document.querySelector(".ken-prompt-body")?.textContent).toBe(KEN_PROMPT);
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledTimes(2));
    expect(pane.prepareContinuationHandoff).toHaveBeenCalledTimes(2);
    act(() => nativeMocks.onSessionReset?.("operation-1"));
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(CONTINUATION_PROMPT, [], { kenSent: true }),
    );
  });

  it("restores the complete handoff after an ambiguous new-session outcome", async () => {
    const pane = client("pane-ken-ambiguous", 1);
    vi.mocked(pane.newSession).mockRejectedValueOnce(
      new NewSessionError("outcome-unknown", "connection closed"),
    );
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t confirm which session is active");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(CONTINUATION_PROMPT);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("times out without guessing and restores the complete handoff to the composer", async () => {
    const pane = client("pane-ken-timeout", 1);
    await renderKenPromptPane(pane);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });

    expect(pane.newSession).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(CONTINUATION_PROMPT);
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t confirm which session");
  });

  it("keeps the fresh session authoritative and restores the prompt when its send fails", async () => {
    const pane = client("pane-ken-post-reset-failure", 1);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("transport failed"));
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledOnce());

    act(() => nativeMocks.onSessionReset?.("operation-1"));

    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(CONTINUATION_PROMPT),
    );
    expect(screen.getByRole("alert").textContent).toContain("new session opened");
    expect(screen.getByRole("alert").textContent).toContain("back in the composer");
    expect(document.querySelector(".user-ken-sent")).toBeNull();
  });

  it("blocks fresh resets during Autopilot review and shares correlation with the toolbar modal", async () => {
    const pane = client("pane-ken-autopilot", 1);
    await renderKenPromptPane(pane);
    const subscriptions = vi.mocked(pane.subscribe).mock.calls;
    const handleEvent = subscriptions[subscriptions.length - 1]?.[0];
    const fresh = screen.getByRole("button", { name: "New session" });
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
