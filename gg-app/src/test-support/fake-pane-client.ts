import { vi } from "vitest";
import type { AgentState, PaneAgentClient, SidecarEvent } from "../agent";

/**
 * A fake per-pane client for rendering the real `AgentPane` in tests, built on
 * the same shape AgentPane.test.tsx uses. `emit` delivers events to every
 * subscribed listener, and `sends` records each prompt as `{ text, attachments }`
 * (the payload upstream observed on the raw `agent_prompt` IPC command).
 */
export function fakePaneClient(
  state: AgentState,
  overrides: Partial<Record<keyof PaneAgentClient, unknown>> = {},
): {
  pane: PaneAgentClient;
  sends: ReturnType<typeof vi.fn>;
  emit: (event: SidecarEvent) => void;
} {
  const paneId = "test-pane";
  const generation = 1;
  const listeners = new Set<(event: SidecarEvent) => void>();
  const sends = vi.fn();
  const ready = { ready: true, error: null, generation, sessionId: paneId };
  const pane = {
    paneId,
    programmatic: vi.fn(async () => new Promise(() => {})),
    create: vi.fn(async () => generation),
    restore: vi.fn(async () => generation),
    dispose: vi.fn(async () => {}),
    subscribe: vi.fn((receive: (event: SidecarEvent) => void) => {
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    }),
    waitForReady: vi.fn(async () => ready),
    status: vi.fn(async () => ready),
    selectWorkspace: vi.fn(async () => generation),
    getState: vi.fn(async () => state),
    getNotes: vi.fn(async () => ({ status: "missing" as const })),
    getNotesDiagnostics: vi.fn(async () => new Promise(() => {})),
    bindRoadmapPhase: vi.fn(async () => ({ status: "missing" as const })),
    previewManualCompletionApproval: vi.fn(async () => ({ status: "missing" as const })),
    commitManualCompletionApproval: vi.fn(async () => ({ status: "nonce-not-found" as const })),
    migrateNotes: vi.fn(),
    saveNotes: vi.fn(),
    startPhase: vi.fn(),
    startNextPhase: vi.fn(),
    cancelPhaseRun: vi.fn(),
    getRoadmapPhaseDraft: vi.fn(async () => null),
    approveRoadmapPhaseDraft: vi.fn(),
    rejectRoadmapPhaseDraft: vi.fn(),
    listModels: vi.fn(async () => [{ id: state.model, provider: state.provider }]),
    listCommands: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listHistory: vi.fn(async () => []),
    getChecklist: vi.fn(async () => null),
    getProgress: vi.fn(async () => null),
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    listJiwa: vi.fn(),
    deleteJiwa: vi.fn(),
    getSubscriptionUsage: vi.fn(async () => new Promise(() => {})),
    enhancePrompt: vi.fn(),
    prewarmCache: vi.fn(async () => {}),
    sendPrompt: vi.fn(async (text: string, attachments: unknown[] = []) => {
      sends({ text, attachments });
      return { queued: false, count: 0 };
    }),
    commitContinuation: vi.fn(),
    prepareContinuationHandoff: vi.fn(),
    cancel: vi.fn(),
    retryCancelledRoadmapStatus: vi.fn(),
    answerAskUser: vi.fn(async () => {}),
    sendKenPrompt: vi.fn().mockResolvedValue(undefined),
    cancelKen: vi.fn().mockResolvedValue(undefined),
    setAutopilot: vi.fn(),
    acceptPlan: vi.fn(),
    revisePlan: vi.fn(),
    cancelQueued: vi.fn(),
    exportTranscriptName: vi.fn(),
    saveTranscript: vi.fn(),
    authOAuthStart: vi.fn(),
    authOAuthCode: vi.fn(),
    newSession: vi.fn(async () => ({ operationId: "operation-1" })),
    getRadioState: vi.fn(async () => new Promise(() => {})),
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
    getSettings: vi.fn(async () => new Promise(() => {})),
    saveSettings: vi.fn(),
    listProjects: vi.fn(async () => new Promise(() => {})),
    searchFiles: vi.fn(async () => []),
    listSessions: vi.fn(async () => new Promise(() => {})),
    getTelegramStatus: vi.fn(),
    saveTelegramConfig: vi.fn(),
    getServeStatus: vi.fn(),
    startServe: vi.fn(),
    stopServe: vi.fn(),
    listMcpServers: vi.fn(),
    addMcpServer: vi.fn(),
    loginMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    ...overrides,
  } as unknown as PaneAgentClient;
  return {
    pane,
    sends,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}
