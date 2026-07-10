import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppSidecarSessionRouter,
  sessionEventSseData,
  type SessionEventFrame,
} from "./app-sidecar-session-router.js";

interface FakeContext {
  transcript: string[];
  running: boolean;
  cancelled: boolean;
  clients: Set<http.ServerResponse>;
  dispose: () => Promise<void>;
}

const openServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function createFakeContext(): FakeContext {
  const clients = new Set<http.ServerResponse>();
  return {
    transcript: [],
    running: false,
    cancelled: false,
    clients,
    async dispose() {
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

async function body(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function startHarness() {
  const router = new AppSidecarSessionRouter<FakeContext>();
  router.add("session-a", createFakeContext());
  router.add("session-b", createFakeContext());

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    if (method === "DELETE" && url.startsWith("/session/")) {
      const id = decodeURIComponent(url.slice("/session/".length));
      void router.deleteAndDispose(id).then((deleted) => json(res, 200, { deleted }));
      return;
    }

    const sessionId = router.sessionIdFromRequest(req, url);
    const context = sessionId ? router.get(sessionId) : undefined;
    if (!sessionId || !context) {
      json(res, 404, { error: "unknown session" });
      return;
    }

    if (method === "GET" && url.startsWith("/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      context.clients.add(res);
      req.on("close", () => context.clients.delete(res));
      return;
    }
    if (method === "POST" && url === "/prompt") {
      void body(req).then((text) => {
        context.transcript.push(text);
        context.running = true;
        for (const client of context.clients) {
          client.write(sessionEventSseData(sessionId, "prompt", { text }));
        }
        json(res, 200, { ok: true });
      });
      return;
    }
    if (method === "POST" && url === "/cancel") {
      context.cancelled = true;
      context.running = false;
      for (const client of context.clients) {
        client.write(sessionEventSseData(sessionId, "cancelled", {}));
      }
      json(res, 200, { cancelled: true });
      return;
    }
    if (method === "GET" && url === "/state") {
      json(res, 200, { running: context.running, cancelled: context.cancelled });
      return;
    }
    if (method === "GET" && url === "/history") {
      json(res, 200, { transcript: context.transcript });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { router, baseUrl: `http://127.0.0.1:${port}` };
}

async function openSse(url: string) {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<SessionEventFrame> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) return JSON.parse(data) as SessionEventFrame;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before an event arrived");
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => undefined);
      abort.abort();
      reader.releaseLock();
    },
  };
}

async function nextSseWithTimeout(
  events: Awaited<ReturnType<typeof openSse>>,
  timeoutMs = 250,
): Promise<{ kind: "event"; frame: SessionEventFrame } | { kind: "timeout" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      events.next().then((frame) => ({ kind: "event" as const, frame })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function request(
  baseUrl: string,
  path: string,
  sessionId?: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(sessionId ? { "x-gg-session": sessionId } : {}) },
  });
}

describe("AppSidecarSessionRouter HTTP isolation", () => {
  it("keeps two prompt, event, cancel, state, history, and disposal routes isolated", async () => {
    const { baseUrl } = await startHarness();
    const eventStreams: Awaited<ReturnType<typeof openSse>>[] = [];

    try {
      const eventsA = await openSse(`${baseUrl}/events?session=session-a`);
      eventStreams.push(eventsA);
      const eventsB = await openSse(`${baseUrl}/events?session=session-b`);
      eventStreams.push(eventsB);

      await request(baseUrl, "/prompt", "session-a", { method: "POST", body: "alpha" });
      await request(baseUrl, "/prompt", "session-b", { method: "POST", body: "bravo" });
      await request(baseUrl, "/prompt", "session-a", { method: "POST", body: "again" });

      await expect(eventsA.next()).resolves.toMatchObject({
        sessionId: "session-a",
        type: "prompt",
        data: { text: "alpha" },
      });
      await expect(eventsB.next()).resolves.toMatchObject({
        sessionId: "session-b",
        type: "prompt",
        data: { text: "bravo" },
      });
      await expect(eventsA.next()).resolves.toMatchObject({ data: { text: "again" } });

      await request(baseUrl, "/cancel", "session-a", { method: "POST" });
      await expect(eventsA.next()).resolves.toMatchObject({
        sessionId: "session-a",
        type: "cancelled",
      });
      await expect(nextSseWithTimeout(eventsB)).resolves.toEqual({ kind: "timeout" });

      const stateA = await (await request(baseUrl, "/state", "session-a")).json();
      const stateB = await (await request(baseUrl, "/state", "session-b")).json();
      expect(stateA).toEqual({ running: false, cancelled: true });
      expect(stateB).toEqual({ running: true, cancelled: false });

      const historyA = await (await request(baseUrl, "/history", "session-a")).json();
      const historyB = await (await request(baseUrl, "/history", "session-b")).json();
      expect(historyA).toEqual({ transcript: ["alpha", "again"] });
      expect(historyB).toEqual({ transcript: ["bravo"] });

      expect((await request(baseUrl, "/state")).status).toBe(404);
      expect((await request(baseUrl, "/state", "missing")).status).toBe(404);
      expect((await fetch(`${baseUrl}/session/session-a`, { method: "DELETE" })).status).toBe(200);
      expect((await request(baseUrl, "/state", "session-a")).status).toBe(404);
      expect((await request(baseUrl, "/state", "session-b")).status).toBe(200);
    } finally {
      await Promise.all(eventStreams.map((events) => events.close()));
    }
  });
});
