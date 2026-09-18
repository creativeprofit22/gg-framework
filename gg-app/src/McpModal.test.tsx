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
  enabled: true,
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

describe("McpModal lifecycle guidance", () => {
  it("limits automatic add/remove refresh to this conversation and qualifies tool availability", async () => {
    render(<McpModal onClose={vi.fn()} />);
    await screen.findByText("No MCP’s configured.");

    expect(
      screen.getByText(
        "Adding or removing servers here automatically refreshes MCP in this conversation. Tools are available only when the server connects and trust requirements are met. Other open conversations are not automatically refreshed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/next app restart/i)).toBeNull();
  });
});

describe("McpModal server status", () => {
  it.each([
    ["trust-blocked", "Project server blocked. Add or re-add it in this project to trust it."],
    ["connection-failed", "Could not connect. Check the server settings and availability."],
  ] as const)(
    "shows readable %s guidance without raw diagnostics",
    async (failureReason, message) => {
      listMcpServersMock.mockResolvedValue([
        {
          ...connectedRow,
          ok: false,
          toolCount: 0,
          failureReason,
          error: "Connection failed: Authorization: Bearer fixture-private-value",
        },
      ]);
      render(<McpModal onClose={vi.fn()} />);
      expect((await screen.findByText(message)).closest(".mcp-item")?.textContent).toContain(
        "example",
      );
      expect(document.body.textContent).not.toContain("fixture-private-value");
      expect(document.body.innerHTML).not.toContain("Authorization:");
    },
  );
  it.each([
    ["connected", { ...connectedRow, failureReason: "connection-failed" as const }],
    ["auth", { ...authRow, failureReason: "connection-failed" as const }],
    ["disabled", { ...authRow, enabled: false, failureReason: "trust-blocked" as const }],
  ])("does not show false failures for %s rows", async (_label, row) => {
    listMcpServersMock.mockResolvedValue([{ ...row, error: "private diagnostic" }]);
    render(<McpModal onClose={vi.fn()} />);
    await screen.findByText("example");
    expect(
      screen.queryByText(/Could not connect|Project server blocked|private diagnostic/),
    ).toBeNull();
  });

  it("shows safe generic guidance for legacy and sanitized connection errors", async () => {
    listMcpServersMock.mockResolvedValue([
      {
        ...connectedRow,
        ok: false,
        error: "Connection failed: [REDACTED]",
      },
    ]);
    render(<McpModal onClose={vi.fn()} />);
    expect(
      await screen.findByText("Could not connect. Check the server settings and availability."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("[REDACTED]");
  });

  it.each([false, true])(
    "shows disabled servers neutrally (requiresAuth: %s)",
    async (requiresAuth) => {
      listMcpServersMock.mockResolvedValue([{ ...authRow, enabled: false, requiresAuth }]);
      render(<McpModal onClose={vi.fn()} />);

      expect(await screen.findByText("Disabled")).toBeTruthy();
      expect(screen.queryByText("Requires login")).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      expect(document.querySelector(".lucide-circle-x")).toBeNull();
      expect(loginMcpServerMock).not.toHaveBeenCalled();
      expect(document.querySelector(".lucide-circle-minus")).not.toBeNull();
    },
  );

  it.each([
    ["connected", connectedRow, ".lucide-circle-check", "2 tools"],
    ["auth-required", authRow, ".lucide-lock", "Requires login"],
    [
      "failed",
      { ...connectedRow, ok: false, toolCount: 0, error: "Connection refused" },
      ".lucide-circle-x",
      null,
    ],
  ] as const)("preserves %s presentation", async (_label, row, icon, text) => {
    listMcpServersMock.mockResolvedValue([row]);
    render(<McpModal onClose={vi.fn()} />);
    await screen.findByText("example");
    expect(document.querySelector(icon)).not.toBeNull();
    expect(screen.queryByText("Disabled")).toBeNull();
    if (text) expect(screen.getByText(text)).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: "Sign in" }))).toBe(row === authRow);
  });
});

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

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not refresh MCP servers",
    );
    expect(screen.getByText("example")).toBeTruthy();
    expect(screen.getByText("2 tools")).toBeTruthy();
  });

  it("shows malformed config as a specific retryable error", async () => {
    listMcpServersMock.mockRejectedValueOnce(
      new Error("An MCP config file is malformed. Fix it, then retry."),
    );
    render(<McpModal onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "MCP config file is malformed",
    );
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
