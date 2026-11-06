// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SidecarEvent } from "./agent";
import { McpElicitModal } from "./McpElicitModal";
import { withViewTransition } from "./view-transition";

vi.mock("./view-transition", () => ({
  withViewTransition: vi.fn((update: () => void) => update()),
}));

const mcpElicitMock = vi.hoisted(() => vi.fn(async () => {}));
const listeners = vi.hoisted(() => new Set<(e: SidecarEvent) => void>());

vi.mock("./agent", () => ({
  mcpElicit: mcpElicitMock,
  subscribe: (fn: (e: SidecarEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));

/** Deliver an `mcp_elicit` frame the way the sidecar's SSE stream would. */
function emitElicit(data: Record<string, unknown>): void {
  act(() => {
    for (const fn of listeners) fn({ type: "mcp_elicit", data } as SidecarEvent);
  });
}

const askSchema = {
  type: "object",
  properties: {
    name: { type: "string", title: "Your name" },
    count: { type: "integer", title: "How many" },
    region: { type: "string", title: "Region", enum: ["eu", "us"], enumNames: ["Europe", "US"] },
    confirm: { type: "boolean", title: "Proceed?" },
  },
  required: ["name"],
};

// jsdom has no layout, so no `scrollIntoView` for the Dropdown's active option.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  mcpElicitMock.mockClear();
  vi.mocked(withViewTransition).mockClear();
  listeners.clear();
});
afterEach(cleanup);

describe("McpElicitModal", () => {
  it.each(["Cancel", "Close", "Escape"])(
    "answers immediately and animates only the settled %s dismissal",
    async (path) => {
      let resolve: () => void = () => {};
      mcpElicitMock.mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      render(<McpElicitModal />);
      emitElicit({
        id: "pending",
        server: "fixture",
        message: "Fictional request",
        requestedSchema: askSchema,
      });
      if (path === "Escape") fireEvent.keyDown(document, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: path }));
      expect(mcpElicitMock).toHaveBeenCalledExactlyOnceWith("pending", "cancel", undefined);
      expect(withViewTransition).not.toHaveBeenCalled();
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(mcpElicitMock).toHaveBeenCalledOnce();
      await act(async () => resolve());
      expect(withViewTransition).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("renders nothing until a server asks", () => {
    render(<McpElicitModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("builds a form from the schema and sends typed content on accept", async () => {
    render(<McpElicitModal />);
    emitElicit({
      id: "elicit-1",
      server: "deploy-mcp",
      message: "Confirm the deployment target",
      requestedSchema: askSchema,
    });

    expect(screen.getByRole("dialog", { name: /deploy-mcp needs your input/i })).toBeTruthy();
    expect(screen.getByText("Confirm the deployment target")).toBeTruthy();

    // Required field empty → cannot send yet.
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Your name *"), { target: { value: "Ken" } });
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "3" } });
    // Region is the shared Dropdown (not a native <select>): open it, pick "Europe".
    const region = screen.getByRole("button", { name: "Region" });
    expect(region.id).toBe(screen.getByText("Region", { selector: "label" }).getAttribute("for"));
    fireEvent.click(region);
    fireEvent.click(screen.getByRole("option", { name: "Europe" }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // `count` must arrive as a number — the SDK validates the result against
    // the same schema and would reject the string "3".
    expect(mcpElicitMock).toHaveBeenCalledWith("elicit-1", "accept", {
      name: "Ken",
      count: 3,
      region: "eu",
      confirm: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends cancel when dismissed with Escape", async () => {
    render(<McpElicitModal />);
    emitElicit({ id: "elicit-2", server: "a", message: "hi", requestedSchema: askSchema });

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(mcpElicitMock).toHaveBeenCalledWith("elicit-2", "cancel", undefined);
  });

  it("sends decline from the Decline action", async () => {
    render(<McpElicitModal />);
    emitElicit({ id: "elicit-3", server: "a", message: "hi", requestedSchema: askSchema });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    });
    expect(mcpElicitMock).toHaveBeenCalledWith("elicit-3", "decline", undefined);
  });

  it("queues a second server's request instead of stacking dialogs", async () => {
    render(<McpElicitModal />);
    emitElicit({ id: "elicit-4", server: "alpha", message: "first", requestedSchema: askSchema });
    emitElicit({ id: "elicit-5", server: "beta", message: "second", requestedSchema: askSchema });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("first")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    });
    // Beta's request takes over the same dialog.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("closes rather than trapping the user when the sidecar rejects the answer", async () => {
    mcpElicitMock.mockRejectedValueOnce(new Error("no elicitation is awaiting a response"));
    render(<McpElicitModal />);
    emitElicit({ id: "elicit-6", server: "a", message: "hi", requestedSchema: askSchema });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
