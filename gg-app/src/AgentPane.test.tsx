// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type * as ReferencedFilesModule from "./ReferencedFiles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPane } from "./AgentPane";

const agentMocks = vi.hoisted(() => ({
  createPaneAgentClient: vi.fn(),
  createPaneSession: vi.fn(),
  disposePaneSession: vi.fn(),
  restoreTarget: vi.fn(),
}));

vi.mock("./agent", () => ({
  ...agentMocks,
  isSecondaryWindow: false,
  getDroppedPathInfo: vi.fn(),
  readDroppedFileAttachment: vi.fn(),
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
vi.mock("./useAutopilot", () => ({
  useAutopilot: () => ({ autopilotReviewing: false, handleAutopilotEvent: vi.fn() }),
}));
vi.mock("./useAgentEvents", () => ({
  HOOK_PRESENTATION: {},
  useAgentEvents: () => ({ handleEvent: vi.fn(), pushItem: vi.fn(), endStreamingText: vi.fn() }),
}));

vi.mock("./ProjectPicker", () => ({
  ProjectPicker: ({
    bindProject,
    onChosen,
  }: {
    bindProject(cwd: string, session?: string): Promise<void>;
    onChosen(cwd: string): void;
  }) => (
    <button
      onClick={() => {
        void bindProject("/work/project", "/work/session.json")
          .then(() => onChosen("/work/project"))
          .catch(() => {});
      }}
    >
      Choose test project
    </button>
  ),
}));
vi.mock("./HomeScreen", () => ({
  HomeScreen: ({ onProjects }: { onProjects(): void }) => (
    <button onClick={onProjects}>Projects</button>
  ),
}));
vi.mock("./LoginScreen", () => ({ LoginScreen: () => null }));
vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
  PromptSendProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./PaneHeader", () => ({
  PaneHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./ActivityBar", () => ({
  ActivityBar: ({ onCancel }: { onCancel(): void }) => (
    <button onClick={onCancel}>Cancel build</button>
  ),
}));
vi.mock("./LiveToolPanel", () => ({ LiveToolPanel: () => null }));
vi.mock("./AttachmentBar", () => ({ AttachmentBar: () => null }));
vi.mock("./ReferencedFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof ReferencedFilesModule>()),
  ReferencedFiles: () => null,
}));
vi.mock("./TitleUsageMeter", () => ({ TitleUsageMeter: () => null }));
vi.mock("./RadioButton", () => ({ RadioButton: () => null }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => null }));
vi.mock("./Toaster", () => ({ Toaster: () => null }));
vi.mock("./WakeScreen", () => ({ WakeScreen: () => null }));
vi.mock("./Skeleton", () => ({
  FooterSkeleton: () => null,
  TranscriptSkeleton: () => null,
  Skeleton: () => null,
}));

interface Client {
  paneId: string;
  subscribe: ReturnType<typeof vi.fn>;
  waitForReady: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  sendPrompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  selectProject: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

function client(paneId: string): Client {
  const empty = vi.fn().mockResolvedValue([]);
  return {
    paneId,
    subscribe: vi.fn(() => vi.fn()),
    waitForReady: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ cwd: "/work/project", model: "model" }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    sendKenPrompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    cancelKen: vi.fn().mockResolvedValue(undefined),
    setAutopilot: vi.fn().mockResolvedValue(false),
    acceptPlan: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(undefined),
    cycleThinking: vi.fn().mockResolvedValue(null),
    listModels: empty,
    switchModel: vi.fn().mockResolvedValue(null),
    switchKenModel: vi.fn().mockResolvedValue(null),
    listCommands: empty,
    listHistory: empty,
    listTasks: empty,
    runTask: vi.fn().mockResolvedValue(undefined),
    runAllTasks: vi.fn().mockResolvedValue(undefined),
    deleteTask: empty,
    listProjects: empty,
    listSessions: empty,
    openProjectPath: vi.fn().mockResolvedValue(undefined),
    searchFiles: empty,
    enhancePrompt: vi.fn(),
    selectProject: vi.fn().mockResolvedValue(2),
  };
}

const props = (paneId: string, kind: "primary" | "auxiliary") => ({
  paneId,
  kind,
  focused: true,
  windowFocused: true,
  onFocus: vi.fn(),
  onSnapshot: vi.fn(),
  registerInput: vi.fn(),
});

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollTo = vi.fn();
  agentMocks.restoreTarget.mockResolvedValue({ cwd: "/work/project" });
  agentMocks.createPaneSession.mockResolvedValue(1);
  agentMocks.disposePaneSession.mockResolvedValue(undefined);
});

describe("AgentPane pane isolation and lifecycle", () => {
  it("keeps input and drop actions registered while the pane is unfocused", async () => {
    const primary = client("primary");
    const paneProps = { ...props("primary", "primary"), focused: false };
    agentMocks.createPaneAgentClient.mockReturnValue(primary);

    render(<AgentPane {...paneProps} />);

    await waitFor(() =>
      expect(paneProps.registerInput).toHaveBeenCalledWith(
        "primary",
        expect.objectContaining({
          focus: expect.any(Function),
          handleNativeDrop: expect.any(Function),
        }),
      ),
    );
    expect(paneProps.onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "primary", activeWork: false }),
    );
  });

  it("keeps primary and auxiliary drafts and subscriptions independent", async () => {
    const clients = new Map(["primary", "pane-2"].map((id) => [id, client(id)]));
    const catalog = client("primary-catalog");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "primary" ? clients.get("primary") : id === "pane-2" ? clients.get("pane-2") : catalog,
    );

    render(
      <>
        <AgentPane {...props("primary", "primary")} />
        <AgentPane {...props("pane-2", "auxiliary")} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
    const [primaryInput, auxiliaryInput] = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    fireEvent.change(primaryInput, { target: { value: "primary draft" } });
    fireEvent.change(auxiliaryInput, { target: { value: "auxiliary draft" } });
    expect(primaryInput.value).toBe("primary draft");
    expect(auxiliaryInput.value).toBe("auxiliary draft");
    expect(clients.get("primary")!.subscribe).toHaveBeenCalled();
    expect(clients.get("pane-2")!.subscribe).toHaveBeenCalled();
    expect(clients.get("primary")!.subscribe).not.toBe(clients.get("pane-2")!.subscribe);
  });

  it("sends and cancels through the owning pane client", async () => {
    const primary = client("primary");
    const auxiliary = client("pane-2");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : primary,
    );
    render(
      <>
        <AgentPane {...props("primary", "primary")} />
        <AgentPane {...props("pane-2", "auxiliary")} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
    await waitFor(() => expect(auxiliary.listHistory).toHaveBeenCalled());
    const auxiliaryInput = screen.getAllByRole("textbox")[1];
    fireEvent.change(auxiliaryInput, { target: { value: "pane two" } });
    fireEvent.keyDown(auxiliaryInput, { key: "Enter" });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel build" })[1]);
    await waitFor(() => {
      expect(auxiliary.sendPrompt).toHaveBeenCalledWith("pane two", [], undefined);
      expect(auxiliary.cancel).toHaveBeenCalledTimes(1);
    });
    expect(primary.sendPrompt).not.toHaveBeenCalled();
    expect(primary.cancel).not.toHaveBeenCalled();
  });

  it("restores a persisted auxiliary target without opening its picker", async () => {
    const auxiliary = client("pane-2");
    const catalog = client("catalog");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : catalog,
    );

    render(
      <AgentPane
        {...props("pane-2", "auxiliary")}
        initialTarget={{ cwd: "/saved/project", sessionPath: "/saved/session.jsonl" }}
      />,
    );

    await waitFor(() => expect(auxiliary.getState).toHaveBeenCalled());
    expect(agentMocks.createPaneSession).toHaveBeenCalledWith(
      "pane-2",
      "/saved/project",
      "/saved/session.jsonl",
    );
    expect(screen.queryByRole("button", { name: "Choose test project" })).toBeNull();
  });

  it("creates, waits, hydrates, and focuses an auxiliary pane", async () => {
    const auxiliary = client("pane-2");
    const catalog = client("catalog");
    const paneProps = props("pane-2", "auxiliary");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : catalog,
    );
    render(<AgentPane {...paneProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(auxiliary.getState).toHaveBeenCalled());
    expect(agentMocks.createPaneSession).toHaveBeenCalledWith(
      "pane-2",
      "/work/project",
      "/work/session.json",
    );
    expect(auxiliary.waitForReady).toHaveBeenCalled();
    await waitFor(() =>
      expect(paneProps.registerInput).toHaveBeenCalledWith(
        "pane-2",
        expect.objectContaining({ focus: expect.any(Function) }),
      ),
    );
    const registration = paneProps.registerInput.mock.calls.find((call) => call[1] !== null)?.[1];
    act(() => registration.focus());
    const textboxes = screen.getAllByRole("textbox");
    expect(document.activeElement).toBe(textboxes[textboxes.length - 1]);
  });

  it("keeps a rejected create retryable without generation-less disposal", async () => {
    const auxiliary = client("pane-2");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : client(id),
    );
    agentMocks.createPaneSession
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValue(7);

    render(<AgentPane {...props("pane-2", "auxiliary")} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(agentMocks.createPaneSession).toHaveBeenCalledTimes(1));
    expect(agentMocks.disposePaneSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose test project" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(auxiliary.getState).toHaveBeenCalled());
    expect(agentMocks.createPaneSession).toHaveBeenCalledTimes(2);
    expect(agentMocks.disposePaneSession).not.toHaveBeenCalled();
  });

  it("disposes a not-ready generation and retries with a fresh native session", async () => {
    const auxiliary = client("pane-2");
    auxiliary.waitForReady.mockRejectedValueOnce(new Error("ready failed"));
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : client(id),
    );
    agentMocks.createPaneSession.mockResolvedValueOnce(11).mockResolvedValueOnce(12);

    render(<AgentPane {...props("pane-2", "auxiliary")} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(agentMocks.disposePaneSession).toHaveBeenCalledWith("pane-2", 11));
    expect(screen.getByRole("button", { name: "Choose test project" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(auxiliary.getState).toHaveBeenCalled());
    expect(agentMocks.createPaneSession).toHaveBeenCalledTimes(2);
    expect(agentMocks.disposePaneSession).not.toHaveBeenCalledWith("pane-2", 12);
  });

  it("ignores and disposes a late create after a newer bind wins", async () => {
    let resolveFirst!: (generation: number) => void;
    const first = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    const auxiliary = client("pane-2");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : client(id),
    );
    agentMocks.createPaneSession.mockReturnValueOnce(first).mockResolvedValueOnce(22);

    render(<AgentPane {...props("pane-2", "auxiliary")} />);
    const choose = screen.getByRole("button", { name: "Choose test project" });
    fireEvent.click(choose);
    fireEvent.click(choose);
    await waitFor(() => expect(auxiliary.getState).toHaveBeenCalled());

    await act(async () => resolveFirst(21));
    expect(agentMocks.disposePaneSession).toHaveBeenCalledWith("pane-2", 21);
    expect(agentMocks.disposePaneSession).not.toHaveBeenCalledWith("pane-2", 22);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("disposes a created auxiliary exactly once and never disposes primary", async () => {
    const auxiliary = client("pane-2");
    const primary = client("primary");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-2" ? auxiliary : primary,
    );
    const auxiliaryRender = render(<AgentPane {...props("pane-2", "auxiliary")} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(agentMocks.createPaneSession).toHaveBeenCalled());
    auxiliaryRender.unmount();
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
    expect(agentMocks.disposePaneSession).toHaveBeenCalledWith("pane-2", 1);

    const primaryRender = render(<AgentPane {...props("primary", "primary")} />);
    await waitFor(() => expect(primary.getState).toHaveBeenCalled());
    primaryRender.unmount();
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
  });

  it("disposes pane-3 exactly once when create resolves after unmount", async () => {
    let resolveCreate!: (generation: number) => void;
    agentMocks.createPaneSession.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const auxiliary = client("pane-3");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "pane-3" ? auxiliary : client(id),
    );
    const view = render(<AgentPane {...props("pane-3", "auxiliary")} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(agentMocks.createPaneSession).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(agentMocks.disposePaneSession).not.toHaveBeenCalled();
    await act(async () => {
      resolveCreate(3);
      await Promise.resolve();
    });
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
    expect(agentMocks.disposePaneSession).toHaveBeenCalledWith("pane-3", 3);
    expect(auxiliary.waitForReady).not.toHaveBeenCalled();
  });
});
