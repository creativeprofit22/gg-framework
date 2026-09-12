// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getSettings,
  listSessions,
  selectWorkspace,
  waitForReady,
  type RecentSession,
} from "./agent";
import { ChatPicker } from "./ChatPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  selectWorkspace: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({
  WindowLayoutButton: () => <button>Windows</button>,
}));

const getSettingsMock = vi.mocked(getSettings);
const listSessionsMock = vi.mocked(listSessions);
const selectWorkspaceMock = vi.mocked(selectWorkspace);
const waitForReadyMock = vi.mocked(waitForReady);

const session: RecentSession = {
  id: "chat-1",
  path: "/sessions/chat-1.jsonl",
  preview: "Plan my week",
  lastActiveDisplay: "2m ago",
  messageCount: 4,
  chatAgent: "therapist",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatPicker", () => {
  it("loads sessions from projectsRoot and resumes them in chat mode", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    selectWorkspaceMock.mockResolvedValue();
    const onChosen = vi.fn();

    render(<ChatPicker onChosen={onChosen} />);

    expect(await screen.findByText("Plan my week")).toBeDefined();
    expect(waitForReadyMock).toHaveBeenCalledOnce();
    expect(listSessionsMock).toHaveBeenCalledWith("/workspaces", "all");

    fireEvent.click(screen.getByText("Plan my week"));
    await waitFor(() => {
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "chat",
        "/workspaces",
        "/sessions/chat-1.jsonl",
        "therapist",
      );
      expect(onChosen).toHaveBeenCalledWith("/workspaces");
    });
  });

  it("starts a new chat without a resume path", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    selectWorkspaceMock.mockResolvedValue();

    render(<ChatPicker onChosen={vi.fn()} />);

    const newChatButtons = await screen.findAllByRole("button", { name: "+ New chat" });
    fireEvent.click(newChatButtons[0]);
    await waitFor(() => {
      expect(selectWorkspaceMock).toHaveBeenCalledWith("chat", "/workspaces", undefined, "general");
    });
  });

  it("starts a new chat with the initially active agent", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    selectWorkspaceMock.mockResolvedValue();

    render(<ChatPicker onChosen={vi.fn()} initialAgent="research" />);
    const newChatButtons = await screen.findAllByRole("button", { name: "+ New chat" });
    fireEvent.click(newChatButtons[0]);

    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalledWith("/workspaces", "all");
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "chat",
        "/workspaces",
        undefined,
        "research",
      );
    });
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("shows selection failures without hiding chats and allows retrying", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    const bindChat = vi
      .fn()
      .mockRejectedValue(new Error("Startup failed. Run `ggcoder login` first."));
    const onChosen = vi.fn();

    render(<ChatPicker onChosen={onChosen} bindChat={bindChat} />);

    const chat = await screen.findByRole("button", { name: /Plan my week/ });
    fireEvent.click(chat);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Startup failed. Use AI Providers to sign in first.",
    );
    expect(screen.getByText("Plan my week")).toBeDefined();
    expect((chat as HTMLButtonElement).disabled).toBe(false);
    expect(onChosen).not.toHaveBeenCalled();

    fireEvent.click(chat);
    await waitFor(() => expect(bindChat).toHaveBeenCalledTimes(2));
    expect(onChosen).not.toHaveBeenCalled();
  });

  it("shows a clear prerequisite error when projectsRoot is unavailable", async () => {
    getSettingsMock.mockResolvedValue(null);

    render(<ChatPicker onChosen={vi.fn()} />);

    expect(
      await screen.findByText("Choose a projects folder in Settings before starting a chat."),
    ).toBeDefined();
    expect(waitForReadyMock).not.toHaveBeenCalled();
    expect(selectWorkspaceMock).not.toHaveBeenCalled();
  });
});
