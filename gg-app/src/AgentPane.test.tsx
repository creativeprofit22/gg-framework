// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";
import type { Item } from "./transcript-types";

HTMLElement.prototype.scrollTo = vi.fn();

const nativeMocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(async () => vi.fn()),
  setWindowTitle: vi.fn(),
  getDroppedPathInfo: vi.fn(async (paths: string[]) =>
    paths.map((path) => ({ path, isDir: path.endsWith("folder") })),
  ),
  modelsChanged: null as null | (() => void),
  modelsUnlisten: vi.fn(),
  onSessionReset: null as null | ((operationId: string | null) => void),
  showPlanReview: null as null | ((content: string) => void),
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
    onSessionReset: (operationId: string | null) => void;
    setItems: Dispatch<SetStateAction<Item[]>>;
    setPlanReview: Dispatch<SetStateAction<string | null>>;
  }) => {
    nativeMocks.onSessionReset = deps.onSessionReset;
    nativeMocks.showPlanReview = (content) => deps.setPlanReview(content);
    return {
      handleEvent: (event: AgentModule.SidecarEvent) => {
        if (event.type !== "session_reset") return deps.handleAutopilotEvent(event);
        const data = event.data as { operationId?: unknown };
        deps.setItems([]);
        deps.onSessionReset(typeof data.operationId === "string" ? data.operationId : null);
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
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./toast", () => ({ toast: nativeMocks.toast }));
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
import type { PaneInputActions, PaneSnapshot } from "./AgentPane";
import type { AgentState, PaneAgentClient, PaneSessionTarget } from "./agent";
import type { NotesDocumentV3 } from "./notes-types";

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
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    sendKenPrompt: vi.fn(),
    cancelKen: vi.fn(),
    setAutopilot: vi.fn(),
    acceptPlan: vi.fn(),
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

async function renderKenPromptPane(pane: PaneAgentClient): Promise<HTMLButtonElement> {
  vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
  vi.mocked(pane.listHistory).mockResolvedValue([
    {
      role: "assistant",
      text: `\`\`\`prompt\n${KEN_PROMPT}\n\`\`\``,
      ken: true,
    },
  ] as Awaited<ReturnType<PaneAgentClient["listHistory"]>>);
  render(<AgentPane client={pane} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
  fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
  return (await screen.findByRole("button", {
    name: /Send to .* Coder/,
  })) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  nativeMocks.modelsChanged = null;
  nativeMocks.modelsUnlisten.mockReset();
  nativeMocks.onSessionReset = null;
  nativeMocks.showPlanReview = null;
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
    expect(screen.getByText("Supah Coder model")).toBeTruthy();

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("Supah Coder model")).toBeNull());
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

    await waitFor(() => expect(modelButton.textContent).toContain("Azure new"));
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
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
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

  it("routes plan-review prompt actions through its auxiliary pane dispatcher", async () => {
    const pane = client("pane-plan-review", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    render(
      <AgentPane
        client={pane}
        paneId="pane-plan-review"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());

    act(() => {
      nativeMocks.showPlanReview?.(`# Plan\n\n\`\`\`prompt\n${KEN_PROMPT}\n\`\`\``);
    });

    const send = await screen.findByRole("button", { name: /Send to .* Coder/ });
    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    expect(
      (screen.getByRole("button", { name: "New session + send" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Save to Notes" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(send);

    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true }),
    );
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
  });

  it("sends a hydrated Ken prompt once with kenSent metadata", async () => {
    const pane = client("pane-ken-send", 1);
    const send = await renderKenPromptPane(pane);

    fireEvent.click(send);

    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true }),
    );
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    expect(document.querySelector(".user-ken-sent")?.textContent).toContain("Sent to");
  });

  it("keeps current-send retryable without a false Sent row after rejection", async () => {
    const pane = client("pane-ken-reject", 1);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("empty prompt"));
    const send = await renderKenPromptPane(pane);

    fireEvent.click(send);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t send");
    expect(document.querySelector(".user-ken-sent")).toBeNull();
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector(".user-ken-sent")).not.toBeNull());
  });

  it("matches the reset broadcast that arrives before the successful response", async () => {
    const pane = client("pane-ken-fresh", 1);
    const creation = deferred<Awaited<ReturnType<PaneAgentClient["newSession"]>>>();
    vi.mocked(pane.newSession).mockReturnValueOnce(creation.promise);
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    const fresh = screen.getByRole("button", { name: "New session + send" });

    fireEvent.click(fresh);
    fireEvent.click(fresh);
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledOnce());
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(
      (screen.getByTitle("Start a new session for this project") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTitle("View and run this project's tasks") as HTMLButtonElement).disabled,
    ).toBe(true);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "must wait for the reset" } });
    const submitEvent = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(submitEvent, ["k", "e", "y"].join(""), {
      value: ["E", "n", "t", "e", "r"].join(""),
    });
    fireEvent(input, submitEvent);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("must wait for the reset");

    act(() => nativeMocks.onSessionReset?.("operation-1"));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    await act(async () => creation.resolve({ operationId: "operation-1" }));
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(KEN_PROMPT, [], { kenSent: true }),
    );
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
  });

  it("keeps the old prompt card after HTTP 409 creation rejection and permits a safe retry", async () => {
    const pane = client("pane-ken-retry-409", 1);
    vi.mocked(pane.newSession).mockRejectedValueOnce(
      new NewSessionError("creation-rejected", "HTTP 409", 409),
    );
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    const fresh = screen.getByRole("button", { name: "New session + send" });

    fireEvent.click(fresh);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t create a new session");
    expect(alert.textContent).toContain("current session is unchanged");
    expect(document.querySelector(".ken-prompt-body")?.textContent).toBe(KEN_PROMPT);
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New session + send" }));
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledTimes(2));
    act(() => nativeMocks.onSessionReset?.("operation-1"));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
  });

  it("uses ambiguous-outcome recovery copy for a transport failure", async () => {
    const pane = client("pane-ken-transport", 1);
    vi.mocked(pane.newSession).mockRejectedValueOnce(new Error("connection closed"));
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));

    fireEvent.click(screen.getByRole("button", { name: "New session + send" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t determine whether a new session opened");
    expect(alert.textContent).toContain("Reopen this project");
    expect(alert.textContent).not.toContain("current session is unchanged");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("reconciles HTTP success when the reset event is lost without a blind second reset", async () => {
    const pane = client("pane-ken-timeout", 1);
    await renderKenPromptPane(pane);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    fireEvent.click(screen.getByRole("button", { name: "New session + send" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });

    expect(pane.newSession).toHaveBeenCalledOnce();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(KEN_PROMPT);
    expect(screen.queryByRole("button", { name: "New session + send" })).toBeNull();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("new session opened"),
      "warning",
      7_000,
    );
    expect(nativeMocks.toast.mock.calls[0]?.[0]).not.toContain("current session is unchanged");
  });

  it("closes the top-bar confirmation after recovering a successful reset with no event", async () => {
    const pane = client("pane-topbar-timeout", 1);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    vi.useFakeTimers();

    fireEvent.click(screen.getByTitle("Start a new session for this project"));
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });

    expect(pane.newSession).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "New Session" })).toBeNull();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("pane was recovered"),
      "warning",
      7_000,
    );
  });

  it("restores the exact prompt to the composer after a post-reset send failure", async () => {
    const pane = client("pane-ken-recover", 1);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("transport failed"));
    await renderKenPromptPane(pane);
    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    fireEvent.click(screen.getByRole("button", { name: "New session + send" }));
    await waitFor(() => expect(pane.newSession).toHaveBeenCalledOnce());

    act(() => nativeMocks.onSessionReset?.("operation-1"));

    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(KEN_PROMPT),
    );
    expect(screen.getByRole("alert").textContent).toContain("back in the composer");
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    expect(document.querySelector(".user-ken-sent")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "New session + send" }) as HTMLButtonElement).disabled,
    ).toBe(false);
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
