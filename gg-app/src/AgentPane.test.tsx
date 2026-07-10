// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type * as ReferencedFilesModule from "./ReferencedFiles";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    selectProject: vi.fn().mockResolvedValue(undefined),
  };
}

const props = (paneId: string, kind: "primary" | "secondary") => ({
  paneId,
  kind,
  focused: true,
  windowFocused: true,
  onFocus: vi.fn(),
  onSnapshot: vi.fn(),
  registerInput: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollTo = vi.fn();
  agentMocks.restoreTarget.mockResolvedValue({ cwd: "/work/project" });
  agentMocks.createPaneSession.mockResolvedValue(undefined);
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

  it("keeps primary and secondary drafts and subscriptions independent", async () => {
    const clients = new Map(["primary", "secondary"].map((id) => [id, client(id)]));
    const catalog = client("primary-catalog");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "primary"
        ? clients.get("primary")
        : id === "secondary"
          ? clients.get("secondary")
          : catalog,
    );

    render(
      <>
        <AgentPane {...props("primary", "primary")} />
        <AgentPane {...props("secondary", "secondary")} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
    const [primaryInput, secondaryInput] = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    fireEvent.change(primaryInput, { target: { value: "primary draft" } });
    fireEvent.change(secondaryInput, { target: { value: "secondary draft" } });
    expect(primaryInput.value).toBe("primary draft");
    expect(secondaryInput.value).toBe("secondary draft");
    expect(clients.get("primary")!.subscribe).toHaveBeenCalled();
    expect(clients.get("secondary")!.subscribe).toHaveBeenCalled();
    expect(clients.get("primary")!.subscribe).not.toBe(clients.get("secondary")!.subscribe);
  });

  it("sends and cancels through the owning pane client", async () => {
    const primary = client("primary");
    const secondary = client("secondary");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "secondary" ? secondary : primary,
    );
    render(
      <>
        <AgentPane {...props("primary", "primary")} />
        <AgentPane {...props("secondary", "secondary")} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
    await waitFor(() => expect(secondary.listHistory).toHaveBeenCalled());
    const secondaryInput = screen.getAllByRole("textbox")[1];
    fireEvent.change(secondaryInput, { target: { value: "pane two" } });
    fireEvent.keyDown(secondaryInput, { key: "Enter" });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel build" })[1]);
    await waitFor(() => {
      expect(secondary.sendPrompt).toHaveBeenCalledWith("pane two", [], undefined);
      expect(secondary.cancel).toHaveBeenCalledTimes(1);
    });
    expect(primary.sendPrompt).not.toHaveBeenCalled();
    expect(primary.cancel).not.toHaveBeenCalled();
  });

  it("restores a persisted secondary target without opening its picker", async () => {
    const secondary = client("secondary");
    const catalog = client("catalog");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "secondary" ? secondary : catalog,
    );

    render(
      <AgentPane
        {...props("secondary", "secondary")}
        initialTarget={{ cwd: "/saved/project", sessionPath: "/saved/session.jsonl" }}
      />,
    );

    await waitFor(() => expect(secondary.getState).toHaveBeenCalled());
    expect(agentMocks.createPaneSession).toHaveBeenCalledWith(
      "secondary",
      "/saved/project",
      "/saved/session.jsonl",
    );
    expect(screen.queryByRole("button", { name: "Choose test project" })).toBeNull();
  });

  it("creates, waits, hydrates, and focuses a secondary pane", async () => {
    const secondary = client("secondary");
    const catalog = client("catalog");
    const paneProps = props("secondary", "secondary");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "secondary" ? secondary : catalog,
    );
    render(<AgentPane {...paneProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(secondary.getState).toHaveBeenCalled());
    expect(agentMocks.createPaneSession).toHaveBeenCalledWith(
      "secondary",
      "/work/project",
      "/work/session.json",
    );
    expect(secondary.waitForReady).toHaveBeenCalled();
    await waitFor(() =>
      expect(paneProps.registerInput).toHaveBeenCalledWith(
        "secondary",
        expect.objectContaining({ focus: expect.any(Function) }),
      ),
    );
    const registration = paneProps.registerInput.mock.calls.find((call) => call[1] !== null)?.[1];
    act(() => registration.focus());
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("disposes a created secondary exactly once and never disposes primary", async () => {
    const secondary = client("secondary");
    const primary = client("primary");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "secondary" ? secondary : primary,
    );
    const secondaryRender = render(<AgentPane {...props("secondary", "secondary")} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(agentMocks.createPaneSession).toHaveBeenCalled());
    secondaryRender.unmount();
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
    expect(agentMocks.disposePaneSession).toHaveBeenCalledWith("secondary");

    const primaryRender = render(<AgentPane {...props("primary", "primary")} />);
    await waitFor(() => expect(primary.getState).toHaveBeenCalled());
    primaryRender.unmount();
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
  });

  it("disposes exactly once when create resolves after unmount", async () => {
    let resolveCreate!: () => void;
    agentMocks.createPaneSession.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const secondary = client("secondary");
    agentMocks.createPaneAgentClient.mockImplementation((id: string) =>
      id === "secondary" ? secondary : client(id),
    );
    const view = render(<AgentPane {...props("secondary", "secondary")} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    await waitFor(() => expect(agentMocks.createPaneSession).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });
    expect(agentMocks.disposePaneSession).toHaveBeenCalledTimes(1);
    expect(secondary.waitForReady).not.toHaveBeenCalled();
  });
});
