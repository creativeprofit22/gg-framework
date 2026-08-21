// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMcpServer,
  isMcpAuthDoneEvent,
  listMcpServers,
  loginMcpServer,
  removeMcpServer,
  listProjects,
  subscribe,
  type SidecarEvent,
} from "./agent";
import { McpModal } from "./McpModal";
import { toast } from "./toast";

let eventHandler: ((event: SidecarEvent) => void) | undefined;

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./agent", () => ({
  addMcpServer: vi.fn(),
  loginMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  listProjects: vi.fn(),
  listMcpServers: vi.fn(),
  subscribe: vi.fn((handler: (event: SidecarEvent) => void) => {
    eventHandler = handler;
    return vi.fn();
  }),
  isMcpAuthDoneEvent: vi.fn(
    (event: SidecarEvent) =>
      event.type === "mcp_auth_done" &&
      typeof event.data === "object" &&
      event.data !== null &&
      typeof (event.data as { name?: unknown }).name === "string" &&
      typeof (event.data as { toolCount?: unknown }).toolCount === "number",
  ),
}));

const addMcpServerMock = vi.mocked(addMcpServer);
const listMcpServersMock = vi.mocked(listMcpServers);
const loginMcpServerMock = vi.mocked(loginMcpServer);
const removeMcpServerMock = vi.mocked(removeMcpServer);
const listProjectsMock = vi.mocked(listProjects);
const subscribeMock = vi.mocked(subscribe);
const isMcpAuthDoneEventMock = vi.mocked(isMcpAuthDoneEvent);
const toastMock = vi.mocked(toast);

beforeEach(() => {
  eventHandler = undefined;
  listMcpServersMock.mockResolvedValue([]);
  listProjectsMock.mockResolvedValue([]);
  addMcpServerMock.mockResolvedValue({
    ok: true,
    name: "example",
    connected: true,
    toolCount: 1,
  });
  loginMcpServerMock.mockResolvedValue();
  removeMcpServerMock.mockResolvedValue({ removed: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const connectedRow = {
  name: "example",
  scope: "global" as const,
  ok: true,
  toolCount: 2,
  kind: "http" as const,
  summary: "https://example.test/mcp",
};

const authRow = {
  ...connectedRow,
  ok: false,
  toolCount: 0,
  requiresAuth: true,
};

describe("McpModal management failures", () => {
  it("shows an accessible initial-load error instead of an empty success state", async () => {
    listMcpServersMock.mockRejectedValueOnce(new Error("Could not load MCP servers. Retry."));

    render(<McpModal onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load MCP servers");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(false);
    expect(screen.queryByText("No MCP’s configured.")).toBeNull();
  });

  it("retains the last known list when refresh fails", async () => {
    listMcpServersMock
      .mockResolvedValueOnce([connectedRow])
      .mockRejectedValueOnce(new Error("Could not refresh MCP servers. Retry."));
    render(<McpModal onClose={vi.fn()} />);
    await screen.findByText("example");

    act(() => {
      eventHandler?.({ type: "mcp_auth_done", data: { name: "example", toolCount: 2 } });
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Could not refresh MCP servers");
    expect(screen.getByText("example")).toBeTruthy();
    expect(screen.getByText("2 tools")).toBeTruthy();
  });

  it("shows malformed config as a specific retryable error", async () => {
    listMcpServersMock.mockRejectedValueOnce(
      new Error("An MCP config file is malformed. Fix it, then retry."),
    );
    render(<McpModal onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("MCP config file is malformed");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(false);
  });

  it("keeps add, remove, and OAuth failures visible with Retry", async () => {
    listMcpServersMock.mockResolvedValue([authRow]);
    addMcpServerMock.mockRejectedValueOnce(new Error("Could not add the MCP server."));
    removeMcpServerMock.mockRejectedValueOnce(new Error("Could not remove the MCP server."));
    loginMcpServerMock.mockRejectedValueOnce(new Error("Could not start MCP sign-in."));
    render(<McpModal onClose={vi.fn()} />);
    await screen.findByText("example");

    fireEvent.change(screen.getByPlaceholderText(/claude mcp add/), {
      target: { value: "claude mcp add example https://example.test/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not add");

    fireEvent.click(screen.getByTitle('Remove "example"'));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not remove");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not start MCP sign-in");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(false);
  });

  it("clears the error only after a successful retry", async () => {
    listMcpServersMock
      .mockRejectedValueOnce(new Error("Could not load MCP servers. Retry."))
      .mockResolvedValueOnce([connectedRow]);
    render(<McpModal onClose={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry" });

    fireEvent.click(retry);

    await screen.findByText("example");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(listMcpServersMock).toHaveBeenCalledTimes(2);
  });
});

describe("McpModal OAuth completion", () => {
  it("displays the typed usable tool count from mcp_auth_done", async () => {
    render(<McpModal onClose={vi.fn()} />);
    await screen.findByText("No MCP’s configured.");

    act(() => {
      eventHandler?.({
        type: "mcp_auth_done",
        data: { name: "duplicate-server", toolCount: 1 },
      });
    });

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'Signed in to "duplicate-server" — 1 tools.',
        "success",
      ),
    );
    expect(isMcpAuthDoneEventMock).toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalledOnce();
  });
});
