import type http from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  handleWorkspaceDirRoutes,
  type WorkspaceDirRouteContext,
} from "./app-sidecar-workspace-dirs.js";

function post(
  ctx: WorkspaceDirRouteContext,
  body: unknown,
  url = "/workspace/add-dir",
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return this;
      },
      setHeader() {},
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as Record<string, unknown> });
      },
    };
    const req = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as unknown as http.IncomingMessage;
    handleWorkspaceDirRoutes(ctx, req, res as unknown as http.ServerResponse, url, "POST");
  });
}

type DirResult = { ok: true; root: string } | { ok: false; error: string };

function ctxFor(
  mode: string,
  addDirectory = vi.fn(async (_dir: string): Promise<DirResult> => ({ ok: true, root: "/w/sdk" })),
) {
  const broadcast = vi.fn();
  const ctx = {
    mode,
    session: { addDirectory, getAdditionalRoots: () => ["/w/sdk"] },
    broadcast,
    footerExtras: () => ({ additionalRoots: ["/w/sdk"] }),
  } as unknown as WorkspaceDirRouteContext;
  return { ctx, addDirectory, broadcast };
}

describe("POST /workspace/add-dir", () => {
  it("adds the folder in Code and Chat windows and refreshes the header", async () => {
    for (const mode of ["code", "chat"]) {
      const { ctx, addDirectory, broadcast } = ctxFor(mode);
      const reply = await post(ctx, { path: "/w/sdk" });
      expect(reply).toEqual({ status: 200, body: { root: "/w/sdk", additionalRoots: ["/w/sdk"] } });
      expect(addDirectory).toHaveBeenCalledWith("/w/sdk");
      expect(broadcast).toHaveBeenCalledWith("extras", { additionalRoots: ["/w/sdk"] });
    }
  });

  it("passes on why a folder can't be added", async () => {
    const { ctx, broadcast } = ctxFor(
      "code",
      vi.fn(async (): Promise<DirResult> => ({ ok: false, error: "Already in the workspace: /w" })),
    );
    expect(await post(ctx, { path: "/w" })).toEqual({
      status: 400,
      body: { error: "Already in the workspace: /w" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("refuses Motion windows and a missing path", async () => {
    const { ctx, addDirectory } = ctxFor("motion");
    expect((await post(ctx, { path: "/w/sdk" })).status).toBe(403);
    expect((await post(ctxFor("code").ctx, {})).status).toBe(400);
    expect(addDirectory).not.toHaveBeenCalled();
  });

  it("removes an added folder and refreshes the header", async () => {
    const removeDirectory = vi.fn(async (): Promise<DirResult> => ({ ok: true, root: "/w/sdk" }));
    const broadcast = vi.fn();
    const ctx = {
      mode: "chat",
      session: { removeDirectory, getAdditionalRoots: () => [] },
      broadcast,
      footerExtras: () => ({ additionalRoots: [] }),
    } as unknown as WorkspaceDirRouteContext;
    const reply = await post(ctx, { path: "/w/sdk" }, "/workspace/remove-dir");
    expect(reply).toEqual({ status: 200, body: { root: "/w/sdk", additionalRoots: [] } });
    expect(removeDirectory).toHaveBeenCalledWith("/w/sdk");
    expect(broadcast).toHaveBeenCalledWith("extras", { additionalRoots: [] });
  });
});

it("ignores other routes", () => {
  const { ctx } = ctxFor("code");
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  expect(handleWorkspaceDirRoutes(ctx, req, {} as http.ServerResponse, "/plugins", "GET")).toBe(
    false,
  );
});
