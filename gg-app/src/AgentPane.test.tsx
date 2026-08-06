// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";
import type * as ToastModule from "./toast";
import type { NotesDocumentV3 } from "./notes-types";

HTMLElement.prototype.scrollTo = vi.fn();

const nativeMocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(async () => vi.fn()),
  setWindowTitle: vi.fn(),
  getDroppedPathInfo: vi.fn(async (paths: string[]) =>
    paths.map((path) => ({ path, isDir: path.endsWith("folder") })),
  ),
  modelsChanged: null as null | (() => void),
  modelsUnlisten: vi.fn(),
  onSessionReset: null as null | ((operationId?: string) => void),
  toast: vi.fn(),
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
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(async () => vi.fn()),
    setTitle: vi.fn(),
  }),
}));
vi.mock("./useKenMentor", () => ({
  useKenMentor: () => ({
    kenRunning: false,
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
    setPlanReview: Dispatch<SetStateAction<string | null>>;
    planReviewPathRef: { current: string | null };
  }) => {
    nativeMocks.onSessionReset = deps.onSessionReset ?? null;
    return {
      handleEvent: (event: AgentModule.SidecarEvent) => {
        if (event.type === "roadmap_phase_draft_change") {
          deps.onRoadmapPhaseDraftChange?.(
            event.data as AgentModule.RoadmapPhaseDraftChangeEvent["data"],
          );
          return true;
        }
        if (event.type === "plan_exit") {
          const data = event.data as { planPath?: unknown; content?: unknown };
          deps.planReviewPathRef.current = typeof data.planPath === "string" ? data.planPath : null;
          deps.setPlanReview(String(data.content ?? ""));
          return true;
        }
        if (event.type !== "session_reset") return deps.handleAutopilotEvent(event);
        const data = event.data as { operationId?: unknown };
        deps.setItems([]);
        deps.onSessionReset?.(typeof data.operationId === "string" ? data.operationId : undefined);
      },
      pushItem: (item: Item) => deps.setItems((current) => [...current, item]),
      endStreamingText: vi.fn(),
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
vi.mock("./update", () => ({ useAppUpdate: () => ({ phase: "idle", progressLines: [] }) }));
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

import { AgentPane } from "./AgentPane";
import { NewSessionError } from "./agent";
import type { Item, PaneInputActions, PaneSnapshot } from "./AgentPane";
import type { AgentState, PaneAgentClient, PaneSessionTarget } from "./agent";

const target: PaneSessionTarget = { mode: "code", cwd: "/work", sessionPath: "/session" };
const agentState = (model: string): AgentState => ({
  provider: "azure",
  model,
  cwd: "/work",
  mode: "code",
  running: false,
});
const KEN_PROMPT = "Implement the guarded session action\n  Preserve this indentation";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    selectWorkspace: vi.fn(),
    getState: vi.fn(async () => ({ running: false })),
    getNotes: vi.fn(async () => ({ status: "missing" as const })),
    migrateNotes: vi.fn(async (document: NotesDocumentV3) => ({
      status: "ok" as const,
      migrated: true,
      snapshot: { projectKey: "/work", revision: 1, document },
    })),
    saveNotes: vi.fn(async (expectedRevision: number, document: NotesDocumentV3) => ({
      status: "ok" as const,
      snapshot: { projectKey: "/work", revision: expectedRevision + 1, document },
    })),
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
    cancel: vi.fn(),
    sendKenPrompt: vi.fn(),
    cancelKen: vi.fn(),
    setAutopilot: vi.fn(),
    acceptPlan: vi.fn(async () => ({ ok: true, planTotal: 0 })),
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
  render(<AgentPane client={pane} />);
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
  nativeMocks.toast.mockReset();
  vi.useRealTimers();
});
describe("AgentPane lifecycle", () => {
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

  it("binds an auxiliary picker through its pane-scoped client", async () => {
    const pane = client("pane-1", 3);
    const onUserTargetChange = vi.fn();
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
        onUserTargetChange={onUserTargetChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));

    await waitFor(() =>
      expect(pane.selectWorkspace).toHaveBeenCalledWith(
        { mode: "code", cwd: "/chosen", sessionPath: "/chosen.jsonl" },
        0,
      ),
    );
    expect(onUserTargetChange).toHaveBeenCalledOnce();
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

  it("refreshes the active model state after daemon respawn", async () => {
    const pane = client("pane-1", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-old"));
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "azure:gpt-old", name: "Azure old", provider: "azure" },
    ]);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const modelButton = await screen.findByTitle("Switch Supah Coder's model");
    await waitFor(() => expect(modelButton.textContent).toContain("Azure old"));
    vi.mocked(pane.getState).mockReset().mockResolvedValue(agentState("azure:gpt-new"));
    vi.mocked(pane.listModels)
      .mockReset()
      .mockResolvedValue([{ id: "azure:gpt-new", name: "Azure new", provider: "azure" }]);

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTitle("Switch Supah Coder's model").textContent).toContain("Azure new"),
    );
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

  it("keeps ordinary plan acceptance on the webview prompt path", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.acceptPlan).mockResolvedValue(undefined);
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
        data: { planPath: "/plans/ordinary.md", content: "## Steps\n1. Build\n2. Verify" },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(
        "The plan has been approved. Implement it now, following each step in order.",
      ),
    );
    expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("holds an implemented /commit action at the inline plan gate, then resumes after approval", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.acceptPlan).mockResolvedValue(undefined);

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
        data: { planPath: "/plans/blocked-commit.md", content: "## Steps\n1. Build\n2. Verify" },
      }),
    );

    expect(await screen.findByRole("region", { name: "Plan approval required" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(continueButton);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("/plans/blocked-commit.md"));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/commit"));
    expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
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
    vi.mocked(pane.acceptPlan).mockResolvedValue(undefined);

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
        data: { planPath: "/plans/active-commit.md", content: "## Steps\n1. Commit" },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("/plans/active-commit.md"));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/commit"));
    expect(pane.sendPrompt).not.toHaveBeenCalledWith("queued steering");
    expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
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

  it("waits for the matching fresh-session reset and handles reset-before-response once", async () => {
    const pane = client("pane-ken-fresh", 1);
    const creation = deferred<Awaited<ReturnType<PaneAgentClient["newSession"]>>>();
    vi.mocked(pane.newSession).mockReturnValueOnce(creation.promise);
    await renderKenPromptPane(pane);
    const fresh = screen.getByRole("button", { name: "New session" });

    fireEvent.click(fresh);
    fireEvent.click(fresh);
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledOnce());
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    act(() => nativeMocks.onSessionReset?.("unrelated-operation"));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    act(() => nativeMocks.onSessionReset?.("operation-1"));
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    await act(async () => creation.resolve({ operationId: "operation-1" }));
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true }),
    );
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
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
    act(() => nativeMocks.onSessionReset?.("operation-1"));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
  });

  it("restores the exact prompt after an ambiguous new-session outcome", async () => {
    const pane = client("pane-ken-ambiguous", 1);
    vi.mocked(pane.newSession).mockRejectedValueOnce(
      new NewSessionError("outcome-unknown", "connection closed"),
    );
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t confirm which session is active");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(KEN_PROMPT);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("times out without guessing and restores the exact prompt to the composer", async () => {
    const pane = client("pane-ken-timeout", 1);
    await renderKenPromptPane(pane);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });

    expect(pane.newSession).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(KEN_PROMPT);
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
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(KEN_PROMPT),
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
