// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  listSessions,
  readSettings,
  selectWorkspace,
  waitForReady,
  type RecentSession,
} from "./agent";
import { ChatPicker } from "./ChatPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  listSessions: vi.fn(),
  readSettings: vi.fn(),
  selectWorkspace: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./useWindowFocused", () => ({ useWindowFocused: () => false }));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({
  WindowLayoutButton: () => <button>Windows</button>,
}));

const readSettingsMock = vi.mocked(readSettings);
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
  it("keeps decorated new-chat buttons native with pane window controls hidden", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    const bindChat = vi.fn(() => new Promise<void>(() => {}));
    render(<ChatPicker onChosen={vi.fn()} bindChat={bindChat} showWindowControls={false} />);

    await screen.findByText("No previous chats yet.");
    const buttons = screen.getAllByRole<HTMLButtonElement>("button", { name: "+ New chat" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.parentElement?.classList.contains("metal-button")).toBe(true);
      expect(button.disabled).toBe(false);
    }
    expect(screen.queryByRole("button", { name: "Radio" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Windows" })).toBeNull();
    fireEvent.click(buttons[1]);
    expect(bindChat).toHaveBeenCalledWith("/workspaces", undefined, "general");
    for (const button of buttons) expect(button.disabled).toBe(true);
    fireEvent.click(buttons[0]);
    expect(bindChat).toHaveBeenCalledOnce();
  });
  it("loads sessions from projectsRoot and resumes them in chat mode", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
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
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
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
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
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
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    const bindChat = vi
      .fn()
      .mockRejectedValue(new Error("Startup failed. Run `ggcoder login` first."));
    const onChosen = vi.fn();

    render(<ChatPicker onChosen={onChosen} bindChat={bindChat} />);

    const chat = await screen.findByRole("button", { name: /Plan my week/ });
    fireEvent.click(chat);

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe(
      "Couldn\u2019t open \u201cPlan my week\u201d: Startup failed. Use AI Providers to sign in first.",
    );
    expect(alert.querySelector("details")).toBeNull();
    expect(screen.getByText("Plan my week")).toBeDefined();
    expect((chat as HTMLButtonElement).disabled).toBe(false);
    expect(onChosen).not.toHaveBeenCalled();

    fireEvent.click(chat);
    await waitFor(() => expect(bindChat).toHaveBeenCalledTimes(2));
    expect(onChosen).not.toHaveBeenCalled();
  });

  it("explains an internal startup failure and retries the same session", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    let finishRetry: () => void = () => {};
    const bindChat = vi
      .fn()
      .mockRejectedValueOnce(new Error("pane 'primary' generation 3 was superseded"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRetry = resolve;
          }),
      );
    const onChosen = vi.fn();

    render(<ChatPicker onChosen={onChosen} bindChat={bindChat} />);
    fireEvent.click(await screen.findByRole("button", { name: /Plan my week/ }));

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("Couldn\u2019t open \u201cPlan my week\u201d. Please try again."),
    ).toBeDefined();
    // The error sits directly under the row that failed, and the row points at it.
    const row = screen.getByRole("button", { name: /Plan my week/ });
    expect(row.nextElementSibling).toBe(alert);
    expect(row.getAttribute("aria-describedby")).toBe(alert.id);
    const details = alert.querySelector("details.picker-error-detail");
    expect(details?.querySelector("code")?.textContent).toBe(
      "pane 'primary' generation 3 was superseded",
    );
    expect(alert.firstElementChild?.textContent).not.toContain("generation");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(bindChat).toHaveBeenCalledTimes(2);
    expect(bindChat).toHaveBeenNthCalledWith(
      2,
      "/workspaces",
      "/sessions/chat-1.jsonl",
      "therapist",
    );
    expect(screen.queryByRole("alert")).toBeNull();

    finishRetry();
    await waitFor(() => expect(onChosen).toHaveBeenCalledWith("/workspaces"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens Motion in its own folder and lists only Motion sessions", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces/", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([]);
    selectWorkspaceMock.mockResolvedValue();
    const onChosen = vi.fn();

    render(<ChatPicker mode="motion" onChosen={onChosen} />);

    expect(await screen.findByText("No motion sessions yet.")).toBeDefined();
    expect(listSessionsMock).toHaveBeenCalledWith("/workspaces/GG Motion", "motion");
    fireEvent.click(screen.getAllByRole("button", { name: "+ New video" })[0]);
    await waitFor(() => {
      expect(selectWorkspaceMock).toHaveBeenCalledWith(
        "motion",
        "/workspaces/GG Motion",
        undefined,
        "general",
      );
      expect(onChosen).toHaveBeenCalledWith("/workspaces/GG Motion");
    });
  });

  it("shows a clear prerequisite error when projectsRoot is unavailable", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "  ", configured: false });

    render(<ChatPicker onChosen={vi.fn()} />);

    expect(
      await screen.findByText("Choose a projects folder in Settings before starting a chat."),
    ).toBeDefined();
    expect(waitForReadyMock).not.toHaveBeenCalled();
    expect(selectWorkspaceMock).not.toHaveBeenCalled();
  });

  it("keeps the drag region on the header wrappers and off every control", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);
    render(<ChatPicker onChosen={vi.fn()} />);
    await screen.findByText("Plan my week");

    const head = document.querySelector(".picker-head") as HTMLElement;
    for (const selector of [".picker-head-main", ".picker-head-window", ".picker-head-actions"]) {
      expect(head.querySelector(selector)?.hasAttribute("data-tauri-drag-region")).toBe(true);
    }
    const controls = head.querySelectorAll("button, input, select");
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
  });

  it("shows the model and the last reply on a session row, and nothing when absent", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([
      { ...session, lastReply: "Here is your week, blocked by focus time.", model: "Claude Opus" },
      { ...session, id: "plain", path: "/plain.jsonl", preview: "Plain row" },
    ]);
    render(<ChatPicker onChosen={vi.fn()} />);

    const row = (await screen.findByText("Plan my week")).closest("button") as HTMLElement;
    expect(row.querySelector(".picker-model-tag")?.textContent).toBe("Claude Opus");
    expect(row.querySelector(".picker-snippet")?.textContent).toBe(
      "Here is your week, blocked by focus time.",
    );
    const plain = screen.getByText("Plain row").closest("button") as HTMLElement;
    expect(plain.querySelector(".picker-model-tag")).toBeNull();
    expect(plain.querySelector(".picker-snippet")).toBeNull();
  });

  it("explains a load failure plainly and retries the load", async () => {
    readSettingsMock.mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockResolvedValueOnce([session]);

    render(<ChatPicker onChosen={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe(
      "Couldn\u2019t load chats. Please try again.",
    );
    expect(alert.querySelector("details code")?.textContent).toBe("sidecar unavailable");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Plan my week")).toBeDefined();
    expect(listSessionsMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed settings read as a load failure, not a missing folder, and retries it", async () => {
    readSettingsMock
      .mockRejectedValueOnce(new Error("settings unreadable"))
      .mockResolvedValueOnce({ projectsRoot: "/workspaces", configured: true });
    waitForReadyMock.mockResolvedValue();
    listSessionsMock.mockResolvedValue([session]);

    render(<ChatPicker onChosen={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe(
      "Couldn\u2019t load chats. Please try again.",
    );
    expect(alert.querySelector("details code")?.textContent).toBe("settings unreadable");
    expect(
      screen.queryByText("Choose a projects folder in Settings before starting a chat."),
    ).toBeNull();
    expect(waitForReadyMock).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Plan my week")).toBeDefined();
    expect(readSettingsMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
