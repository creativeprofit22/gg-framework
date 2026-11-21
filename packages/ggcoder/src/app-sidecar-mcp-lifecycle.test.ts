import { describe, expect, it, vi } from "vitest";
import { applyDesktopMcpMutation } from "./app-sidecar-mcp-lifecycle.js";

describe("desktop MCP mutation boundary", () => {
  it("does not report a persisted mutation complete until the current session reloads", async () => {
    const order: string[] = [];
    let finishReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    const session = {
      reloadMcpServers: vi.fn(async () => {
        order.push("reload:start");
        await reloadGate;
        order.push("reload:done");
      }),
    };

    const completion = applyDesktopMcpMutation(
      () => session,
      async () => {
        order.push("persist");
        return { ok: true };
      },
    ).then((result) => {
      order.push("respond");
      return result;
    });

    await vi.waitFor(() => expect(order).toEqual(["persist", "reload:start"]));
    finishReload();

    await expect(completion).resolves.toEqual({ ok: true });
    expect(order).toEqual(["persist", "reload:start", "reload:done", "respond"]);
  });

  it("reloads only successful add, removal, or OAuth mutations", async () => {
    const session = { reloadMcpServers: vi.fn(async () => {}) };

    await applyDesktopMcpMutation(
      () => session,
      async () => ({ ok: false }),
      (result) => result.ok,
    );
    await applyDesktopMcpMutation(
      () => session,
      async () => ({ removed: false }),
      (result) => result.removed,
    );
    expect(session.reloadMcpServers).not.toHaveBeenCalled();

    await applyDesktopMcpMutation(
      () => session,
      async () => ({ ok: true }),
      (result) => result.ok,
    );
    await applyDesktopMcpMutation(
      () => session,
      async () => ({ removed: true }),
      (result) => result.removed,
    );
    expect(session.reloadMcpServers).toHaveBeenCalledTimes(2);
  });

  it("reloads the pane's current AgentSession when it changes during persistence", async () => {
    const temporarySession = { reloadMcpServers: vi.fn(async () => {}) };
    const activeSession = { reloadMcpServers: vi.fn(async () => {}) };
    let currentSession = temporarySession;

    await applyDesktopMcpMutation(
      () => currentSession,
      async () => {
        currentSession = activeSession;
        return { ok: true };
      },
      (result) => result.ok,
    );

    expect(temporarySession.reloadMcpServers).not.toHaveBeenCalled();
    expect(activeSession.reloadMcpServers).toHaveBeenCalledOnce();
  });
});
