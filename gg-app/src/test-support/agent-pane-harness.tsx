// Shared setup for the AgentPane.*.test.tsx files. Vitest only hoists vi.mock
// calls written in a test file, so each file registers the mocks and delegates
// to the factories here. Runtime imports must avoid ./AgentPane and every mocked
// module: the "./agent" factory loads this file, so those would be circular.
import { useCallback } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type * as AgentModule from "../agent";
import type * as ProgrammaticChatModule from "../ProgrammaticChat";
import type { ProgrammaticChatRequest } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type { PaneEventEnvelope } from "../pane-routing";
import type * as MentorModule from "../useKenMentor";
import type * as EventsModule from "../useAgentEvents";
import type * as ProgressModule from "../useProgress";
import type * as ToastModule from "../toast";
import type { RoadmapPhaseDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import type { NotesDocumentV3 } from "../notes-types";
import type { Item } from "../AgentPane";
import type {
  AgentState,
  PaneAgentClient,
  PaneSessionTarget,
  ProjectTask,
  SidecarEvent,
} from "../agent";

type ImportOriginal = <T>() => Promise<T>;

export const nativeMocks = {
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
    async () => undefined,
  ),
  onDragDropEvent: vi.fn(async () => vi.fn()),
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  setWindowTitle: vi.fn(),
  getDroppedPathInfo: vi.fn(async (paths: string[]) =>
    paths.map((path) => ({ path, isDir: path.endsWith("folder") })),
  ),
  agentEvent: null as null | ((event: { payload: PaneEventEnvelope }) => void),
  modelsChanged: null as null | (() => void),
  modelsUnlisten: vi.fn(),
  onSessionReset: null as null | ((operationId?: string) => void),
  kenStateRef: null as null | { current: AgentModule.AgentState | null },
  kenRunning: false,
  realMentor: false,
  realProgress: false,
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
};

export const programmaticView = {
  onAction: null as null | ((request: ProgrammaticChatRequest) => void),
  onSelect: null as null | ((id: string) => void),
};

export async function programmaticChatModuleMock(importOriginal: ImportOriginal) {
  const actual = await importOriginal<typeof ProgrammaticChatModule>();
  return {
    ...actual,
    ProgrammaticChat: (props: Parameters<typeof actual.ProgrammaticChat>[0]) => {
      programmaticView.onAction = props.onAction;
      programmaticView.onSelect = props.onSelect;
      return <actual.ProgrammaticChat {...props} />;
    },
  };
}

export const tauriCoreModuleMock = () => ({ invoke: nativeMocks.invoke });
export const tauriWebviewModuleMock = () => ({
  getCurrentWebview: () => ({ onDragDropEvent: nativeMocks.onDragDropEvent }),
});
export const tauriDialogModuleMock = () => ({
  open: nativeMocks.openDialog,
  save: nativeMocks.saveDialog,
});
export const tauriWebviewWindowModuleMock = () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(
      async (name: string, receive: (event: { payload: PaneEventEnvelope }) => void) => {
        if (name === "agent-event") nativeMocks.agentEvent = receive;
        return vi.fn();
      },
    ),
    setTitle: vi.fn(),
  }),
});

export async function kenMentorModuleMock(importOriginal: ImportOriginal) {
  const actual = await importOriginal<typeof MentorModule>();
  const captureKenHydration = () => vi.fn();
  const clearKenStream = vi.fn();
  return {
    useKenMentor: (opts: Parameters<typeof MentorModule.useKenMentor>[0]) => {
      const real = actual.useKenMentor(opts);
      return nativeMocks.realMentor
        ? real
        : {
            kenRunning: nativeMocks.kenRunning,
            kenTokens: 0,
            kenRunStartTs: null,
            handleKenEvent: vi.fn(),
            hydrateKen: vi.fn(),
            captureKenHydration,
            clearKenStream,
            captureKenTarget: () => ({ conversationId: "conversation", activationEpoch: "epoch" }),
            captureKenRun: () => ({
              conversationId: "conversation",
              activationEpoch: "epoch",
              runId: "run",
            }),
            captureKenOperation: () => () => true,
          };
    },
  };
}

export async function progressModuleMock(importOriginal: ImportOriginal) {
  const actual = await importOriginal<typeof ProgressModule>();
  return {
    useProgress: (client: PaneAgentClient) =>
      nativeMocks.realProgress
        ? actual.useProgress(client)
        : { snapshot: null, levelUp: null, levelUpNonce: null, levelUpOrigin: false },
  };
}

export async function agentEventsModuleMock(importOriginal: ImportOriginal) {
  const actual = await importOriginal<typeof EventsModule>();
  return {
    useAgentEvents: (deps: Parameters<typeof EventsModule.useAgentEvents>[0]) => {
      const real = actual.useAgentEvents(deps);
      const { planReviewPathRef, setPlanReview } = deps;
      nativeMocks.onSessionReset = deps.onSessionReset ?? null;
      nativeMocks.kenStateRef = deps.stateRef;
      const replacePlanReview = useCallback(
        (review: AgentModule.PendingPlanReview | null) => {
          planReviewPathRef.current = review?.planPath ?? null;
          setPlanReview(review);
        },
        [planReviewPathRef, setPlanReview],
      );
      return nativeMocks.realMentor
        ? real
        : {
            handleEvent: (event: AgentModule.SidecarEvent) => {
              if (event.type === "continuation_accepted") {
                deps.onContinuationAccepted?.(event.data);
                return true;
              }
              if (event.type === "ken_text") {
                deps.setItems((current) => [
                  ...current,
                  { kind: "ken", id: 99999, text: String((event.data as { text: string }).text) },
                ]);
                return true;
              }
              if (event.type === "roadmap_phase_draft_change") {
                deps.onRoadmapPhaseDraftChange?.(
                  event.data as AgentModule.RoadmapPhaseDraftChangeEvent["data"],
                );
                return true;
              }
              if (event.type === "plan_exit") {
                const data = event.data as Record<string, unknown>;
                deps.planReviewPathRef.current =
                  typeof data.planPath === "string" ? data.planPath : null;
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
              const data = event.data as Record<string, unknown>;
              if (deps.shouldApplySessionReset && !deps.shouldApplySessionReset(data)) return;
              deps.setItems([]);
              deps.onSessionReset?.(
                typeof data.operationId === "string" ? data.operationId : undefined,
              );
            },
            pushItem: (item: Item) => deps.setItems((current) => [...current, item]),
            acceptSubmission: real.acceptSubmission,
            endStreamingText: vi.fn(),
            replacePlanReview,
          };
    },
  };
}

export const homeScreenModuleMock = () => ({
  HomeScreen: (props: {
    onProjects?: () => void;
    waitForAgentReady?: () => Promise<unknown>;
    loadProgress?: () => Promise<unknown>;
    onSettings?: (tab?: string) => void;
  }) => (
    <div
      data-testid="home-screen"
      data-has-pane-ready={String(typeof props.waitForAgentReady === "function")}
      data-has-pane-progress={String(typeof props.loadProgress === "function")}
    >
      <button onClick={props.onProjects}>Open projects</button>
      <button onClick={() => props.onSettings?.("mcp")}>Open MCP settings</button>
    </div>
  ),
});
export const settingsScreenModuleMock = () => ({
  SettingsScreen: (props: {
    initialTab?: string;
    mcpClient?: { paneId: string };
    onClose: () => void;
  }) => (
    <div
      data-testid="settings-screen"
      data-tab={props.initialTab ?? "general"}
      data-mcp-pane={props.mcpClient?.paneId ?? "none"}
    >
      <button onClick={props.onClose}>Back</button>
    </div>
  ),
});
export const projectPickerModuleMock = () => ({
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
});
export const updateModuleMock = () => ({ useAppUpdate: () => nativeMocks.appUpdate });
export const buildInfoModuleMock = () => ({
  formatBuildIdentity: () => "Supah Coder Local Fork · abc1234",
});
export const soundsModuleMock = () => ({ playSound: vi.fn(), isSoundEnabled: () => true });
export async function toastModuleMock(importOriginal: ImportOriginal) {
  return {
    ...(await importOriginal<typeof ToastModule>()),
    toast: nativeMocks.toast,
  };
}
export const radioButtonModuleMock = () => ({ RadioButton: () => null });
export async function agentModuleMock(importOriginal: ImportOriginal) {
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
}

export const target: PaneSessionTarget = { mode: "code", cwd: "/work", sessionPath: "/session" };
export const chatTarget: PaneSessionTarget = {
  mode: "chat",
  chatAgent: "general",
  cwd: "/work",
  sessionPath: "/chat-session",
};
export const motionTarget: PaneSessionTarget = {
  mode: "motion",
  cwd: "/work",
  sessionPath: "/motion-session",
};
export const roadmapDraft: RoadmapPhaseDraft = {
  id: "draft-research",
  projectKey: "/work",
  basedOnRevision: 12,
  createdAt: "2026-08-08T12:00:00.000Z",
  createdBySessionId: "research-session",
  sourcesNotCited: null,
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
export const agentState = (model: string): AgentState => ({
  accountId: null,
  openAICodexContextProfileEligibility: { canChange: true },
  openAICodexContextProfile: "stable",
  contextTokens: 0,
  contextWindow: 200_000,
  provider: "azure",
  model,
  cwd: "/work",
  mode: "code",
  running: false,
});
export const projectTask: ProjectTask = {
  id: "task-1",
  title: "Keep this task visible",
  prompt: "Preserve task state when requests fail",
  status: "pending",
  createdAt: "2026-09-04T00:00:00.000Z",
};
export const KEN_PROMPT = "Implement the guarded session action\n  Preserve this indentation";
export const CONTINUATION_PROMPT = `## Objective
Continue safely.

## Ken’s next instruction
${KEN_PROMPT}`;

export function deferred<T>(): {
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

const paneEmitters = new WeakMap<PaneAgentClient, (event: SidecarEvent) => void>();
// [DBG-hydration-7c91] Registered only by the stale-hydration diagnostic test.
export const paneListenerObservers = new WeakMap<
  PaneAgentClient,
  (action: "attach" | "detach", count: number) => void
>();
let hydrationCleanupObserver:
  ((phase: "cleanup-start" | "cleanup-end" | "release") => void) | undefined;
export function setHydrationCleanupObserver(observer: typeof hydrationCleanupObserver): void {
  hydrationCleanupObserver = observer;
}

// Mirror native fan-out to active subscribers, not whichever hook subscribed last.
export function paneEvents(pane: PaneAgentClient): (event: SidecarEvent) => void {
  const existing = paneEmitters.get(pane);
  if (existing) return existing;
  const listeners = new Set<(event: SidecarEvent) => void>();
  vi.mocked(pane.subscribe).mockImplementation((receive) => {
    listeners.add(receive);
    paneListenerObservers.get(pane)?.("attach", listeners.size);
    return () => {
      listeners.delete(receive);
      paneListenerObservers.get(pane)?.("detach", listeners.size);
    };
  });
  const emit = (event: SidecarEvent) => {
    for (const receive of listeners) receive(event);
  };
  paneEmitters.set(pane, emit);
  return emit;
}

export function liveEvents(pane: PaneAgentClient) {
  const emit = paneEvents(pane);
  return (type: string, data: object) => emit({ type, data });
}

export function client(paneId: string, generation: number): PaneAgentClient {
  const pane = {
    paneId,
    programmatic: vi.fn(async () => ({
      version: 1,
      action: "report",
      ok: true,
      report: {
        status: "setup-required",
        reason: "Inspect setup",
        scan: { available: false, reason: "Approve current setup." },
        snapshot: null,
        fingerprint: null,
        offset: 0,
        total: 0,
        rows: [],
      },
    })),
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
    listModels: vi.fn(async () => []),
    listCommands: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listHistory: vi.fn(async () => []),
    getProgress: vi.fn(async () => null),
    getTrophies: vi.fn(async () => null),
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    listJiwa: vi.fn(),
    deleteJiwa: vi.fn(),
    getSubscriptionUsage: vi.fn(),
    enhancePrompt: vi.fn(),
    prewarmCache: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => ({ queued: false, count: 0 })),
    commitContinuation: vi.fn(),
    prepareContinuationHandoff: vi.fn(async () => ({
      version: 1 as const,
      preparedId: "prepared-1",
      source: {
        conversationId: "conversation-1",
        sessionId: "session-1",
        leafId: null,
        fingerprint: "fingerprint-1",
      },
      expiresAt: Date.now() + 60_000,
      prompt: CONTINUATION_PROMPT,
    })),
    cancel: vi.fn(),
    answerAskUser: vi.fn(async () => {}),
    sendKenPrompt: vi.fn().mockResolvedValue(undefined),
    cancelKen: vi.fn().mockResolvedValue(undefined),
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
    switchKenModel: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    listProjects: vi.fn(),
    searchFiles: vi.fn(async () => []),
    listSessions: vi.fn(),
    renameSession: vi.fn(),
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
  paneEvents(pane);
  return pane;
}

// AgentPane is loaded lazily: a static import would close the cycle through
// the "./agent" mock factory. The test file already imported it, so it is cached.
const loadAgentPane = async () => (await import("../AgentPane")).AgentPane;

export async function renderKenPromptPane(
  pane: PaneAgentClient,
  running = false,
  prompt = KEN_PROMPT,
  onGenerationChange?: (generation: number) => void,
  stateOverrides: Partial<AgentState> = {},
): Promise<HTMLButtonElement> {
  const AgentPane = await loadAgentPane();
  vi.mocked(pane.getState).mockResolvedValue({
    ...agentState("azure:gpt-test"),
    running,
    runState: running ? "running" : "idle",
    ...stateOverrides,
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
  // The prompt actions live in the real lazy Markdown renderer. Flush its module
  // load inside React's async boundary, including when this fixture runs first.
  await act(async () => {
    await import("../Markdown");
  });
  return (await screen.findAllByRole("button", { name: "Continue here" }))[0] as HTMLButtonElement;
}

export async function openTasksModal(pane: PaneAgentClient): Promise<void> {
  const AgentPane = await loadAgentPane();
  vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
  render(<AgentPane client={pane} target={target} />);
  fireEvent.click(await screen.findByRole("button", { name: "Tasks, 1 pending" }));
  await findTasksPanel();
}

/**
 * Tasks opens as the deck's "Tasks" region. The embedded Tasks list must not
 * announce a second, nested "Tasks" region inside it.
 */
export async function findTasksPanel(): Promise<HTMLElement> {
  const regions = await screen.findAllByRole("region", { name: "Tasks" });
  expect(regions).toHaveLength(1);
  const [panel] = regions;
  if (!panel?.classList.contains("deck-panel-host")) throw new Error("missing Tasks deck panel");
  return panel;
}

/** Autopilot moved into the ⋯ More deck panel; open it and return the switch. */
export async function openAutopilotToggle(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  return screen.findByRole("switch", { name: "Autopilot" });
}

/** Astra context controls live in each pane's ⋯ More deck menu; open them all. */
export async function openMoreMenus(count = 1): Promise<void> {
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "More" }).length).toBeGreaterThanOrEqual(count),
  );
  for (const more of screen.getAllByRole("button", { name: "More" })) fireEvent.click(more);
}

export function expectAutopilotChecked(toggle: HTMLElement, checked: boolean): void {
  expect(toggle.getAttribute("aria-checked")).toBe(String(checked));
}

/** Shows one Opportunities step: setup is on Quick checks, saved results on Review. */
export async function openStep(label: "Quick checks" | "Find ideas" | "Review"): Promise<void> {
  fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^\\d\\s*${label}`) }));
}
/** The shown step; the header key may repeat one of its labels. */
export const inStep = () => within(screen.getByRole("tabpanel"));

/** The title bar also exposes "New session"; Ken prompt cards are queried within their own block. */
export function kenNewSession(index = 0): HTMLElement {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(".ken-prompt-block")).flatMap(
    (block) => within(block).queryAllByRole("button", { name: "New session" }),
  );
  const button = buttons[index];
  if (button === undefined)
    throw new Error(`Ken prompt card New session button ${index} not found`);
  return button;
}

// Same hooks, same registration order as the original single test file.
export function installAgentPaneHooks(): void {
  HTMLElement.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();

  // jsdom has no media-query API; retain the real effects components in these tests.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  afterEach(() => {
    const observe = hydrationCleanupObserver;
    try {
      observe?.("cleanup-start");
      cleanup();
      observe?.("cleanup-end");
    } finally {
      hydrationCleanupObserver = undefined;
      observe?.("release");
    }
    vi.clearAllMocks();
    nativeMocks.invoke.mockResolvedValue(undefined);
    nativeMocks.modelsChanged = null;
    nativeMocks.modelsUnlisten.mockReset();
    nativeMocks.onSessionReset = null;
    nativeMocks.kenRunning = false;
    nativeMocks.realMentor = false;
    nativeMocks.toast.mockReset();
    nativeMocks.appUpdate.phase = "idle";
    nativeMocks.appUpdate.localPatched = true;
    nativeMocks.appUpdate.install.mockReset();
    vi.useRealTimers();
  });
}
