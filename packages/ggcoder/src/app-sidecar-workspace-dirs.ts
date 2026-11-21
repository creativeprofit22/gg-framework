import type http from "node:http";
import { json, readBody } from "./app-sidecar/http.js";

type DirResult = { ok: true; root: string } | { ok: false; error: string };

export interface WorkspaceDirRouteContext {
  mode: string;
  session: {
    addDirectory(dir: string): Promise<DirResult>;
    removeDirectory(dir: string): Promise<DirResult>;
    getAdditionalRoots(): readonly string[];
  };
  broadcast(type: string, data: unknown): void;
  footerExtras(): unknown;
}

/**
 * "Add folder" / "Remove folder" in the More panel: another folder GG can
 * work in, in Code and Chat windows. The model hears from the environment note.
 */
export function handleWorkspaceDirRoutes(
  ctx: WorkspaceDirRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method !== "POST" || (url !== "/workspace/add-dir" && url !== "/workspace/remove-dir")) {
    return false;
  }
  void readBody(req, res).then(async (raw) => {
    if (raw === null) return;
    let dir: unknown;
    try {
      dir = (JSON.parse(raw) as { path?: unknown }).path;
    } catch {
      json(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof dir !== "string" || !dir.trim()) {
      json(res, 400, { error: "path is required" });
      return;
    }
    if (ctx.mode !== "code" && ctx.mode !== "chat") {
      json(res, 403, { error: "folders can be changed only in Code and Chat windows" });
      return;
    }
    const result =
      url === "/workspace/add-dir"
        ? await ctx.session.addDirectory(dir)
        : await ctx.session.removeDirectory(dir);
    if (!result.ok) {
      json(res, 400, { error: result.error });
      return;
    }
    // The header's root badge and the `/` menu follow the extras.
    ctx.broadcast("extras", ctx.footerExtras());
    json(res, 200, { root: result.root, additionalRoots: ctx.session.getAdditionalRoots() });
  });
  return true;
}
