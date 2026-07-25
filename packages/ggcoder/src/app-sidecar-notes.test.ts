import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSidecarNotesHandler, type AppSidecarNotesSession } from "./app-sidecar-notes.js";
import { ProjectNotesRepository, type NotesDocumentV2 } from "./project-notes-repository.js";

const NOW = "2026-07-25T12:00:00.000Z";

interface FakeSession extends AppSidecarNotesSession {
  events: Array<{ type: string; data: unknown }>;
}

let root: string;
let server: http.Server;
let baseUrl: string;
let sessions: Map<string, FakeSession>;
let repository: ProjectNotesRepository;

function notes(reference: string): NotesDocumentV2 {
  return {
    version: 2,
    reference,
    currentFocus: "Sidecar authority",
    tasks: [
      {
        id: "task-1",
        text: "Route the notes",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
    ],
    handoff: { text: "Exact handoff", updatedAt: NOW, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
  };
}

function fakeSession(cwd: string): FakeSession {
  const events: FakeSession["events"] = [];
  return {
    cwd,
    events,
    broadcastNotesChange(snapshot) {
      events.push({ type: "notes_change", data: snapshot });
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-sidecar-notes-route-"));
  repository = new ProjectNotesRepository(path.join(root, ".gg"));
  sessions = new Map([
    ["a", fakeSession("C:\\Work\\Project")],
    ["alias", fakeSession("c:/work/./project")],
    ["other", fakeSession("C:\\Work\\Other")],
  ]);
  const handler = createAppSidecarNotesHandler({
    repository,
    sessions: { values: () => sessions.values() },
  });
  server = http.createServer((req, res) => {
    const header = req.headers["x-gg-session"];
    const id = typeof header === "string" ? header : header?.[0];
    const context = id ? sessions.get(id) : undefined;
    if (!context) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    if (!handler.handle(req, res, context, req.url ?? "/", req.method ?? "GET")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await fs.rm(root, { recursive: true, force: true });
});

async function request(
  sessionId: string,
  route: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      "x-gg-session": sessionId,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return { response, body: (await response.json()) as unknown };
}

describe("app sidecar Notes routes", () => {
  it("returns a typed missing result for a project with no repository", async () => {
    const result = await request("a", "/notes");

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ status: "missing" });
  });

  it("migrates with the authenticated session cwd and returns the stored snapshot", async () => {
    const document = notes("  legacy\r\nbytes 😀\n");
    const migrated = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document }),
    });
    const loaded = await request("alias", "/notes");

    expect(migrated.response.status).toBe(200);
    expect(migrated.body).toEqual({
      status: "ok",
      migrated: true,
      snapshot: { projectKey: "c:/work/project", revision: 1, document },
    });
    expect(loaded.body).toMatchObject({
      status: "ok",
      snapshot: { projectKey: "c:/work/project", revision: 1, document },
    });
  });

  it("rejects malformed JSON, extra fields, invalid revisions, and invalid documents", async () => {
    const malformed = await request("a", "/notes/migrate", {
      method: "POST",
      body: "{broken",
    });
    const extra = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("x"), cwd: "/attacker/chosen" }),
    });
    const revision = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: -1, document: notes("x") }),
    });
    const document = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: { ...notes("x"), version: 99 } }),
    });

    expect(malformed).toMatchObject({
      response: { status: 400 },
      body: { status: "invalid", reason: "malformed-json" },
    });
    expect(extra.body).toEqual({ status: "invalid", reason: "invalid-body" });
    expect(revision.body).toEqual({ status: "invalid", reason: "invalid-body" });
    expect(document.body).toEqual({ status: "invalid" });
  });

  it("returns the winning snapshot in a typed stale-write conflict", async () => {
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("base") }),
    });
    const winner = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("winner") }),
    });
    const stale = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("stale") }),
    });

    expect(winner.response.status).toBe(200);
    expect(winner.body).toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: { reference: "winner" } },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toEqual({
      status: "conflict",
      snapshot: {
        projectKey: "c:/work/project",
        revision: 2,
        document: notes("winner"),
      },
    });
  });

  it("serializes simultaneous migration behind create-if-absent", async () => {
    const [first, second] = await Promise.all([
      request("a", "/notes/migrate", {
        method: "POST",
        body: JSON.stringify({ document: notes("first") }),
      }),
      request("alias", "/notes/migrate", {
        method: "POST",
        body: JSON.stringify({ document: notes("second") }),
      }),
    ]);
    const bodies = [first.body, second.body] as Array<{
      status: string;
      migrated: boolean;
      snapshot: unknown;
    }>;

    expect(bodies.filter((body) => body.migrated)).toHaveLength(1);
    expect(bodies.filter((body) => !body.migrated)).toHaveLength(1);
    expect(bodies[0]?.snapshot).toEqual(bodies[1]?.snapshot);
  });

  it("fans committed snapshots to every same-project alias and isolates other projects", async () => {
    const migrated = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("migrated") }),
    });
    const saved = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("saved") }),
    });

    expect(migrated.response.status).toBe(200);
    expect(saved.response.status).toBe(200);
    expect(sessions.get("a")?.events).toEqual([
      { type: "notes_change", data: expect.objectContaining({ revision: 1 }) },
      { type: "notes_change", data: expect.objectContaining({ revision: 2 }) },
    ]);
    expect(sessions.get("alias")?.events).toEqual(sessions.get("a")?.events);
    expect(sessions.get("other")?.events).toEqual([]);
  });

  it("returns typed corruption and preserves the corrupt files", async () => {
    const paths = repository.paths("C:\\Work\\Project");
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(paths.primary, "{primary", "utf8");
    await fs.writeFile(paths.backup, "{backup", "utf8");

    const loaded = await request("a", "/notes");
    const migrated = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("replacement") }),
    });

    expect(loaded.response.status).toBe(409);
    expect(loaded.body).toEqual({
      status: "corrupt",
      primary: "malformed-json",
      backup: "malformed-json",
    });
    expect(migrated.response.status).toBe(409);
    expect(await fs.readFile(paths.primary, "utf8")).toBe("{primary");
    expect(await fs.readFile(paths.backup, "utf8")).toBe("{backup");
  });

  it("owns only the exact Notes routes", async () => {
    const missing = await request("a", "/notes/other");
    const wrongMethod = await request("a", "/notes", { method: "POST" });

    expect(missing.response.status).toBe(404);
    expect(wrongMethod.response.status).toBe(405);
  });
});
