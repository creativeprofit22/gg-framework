import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  appSidecarChatCommandsResponse,
  handleAppSidecarChatResearchPrompt,
} from "./app-sidecar-chat-research-route.js";

interface FakeMarker {
  kind: "agent_handoff" | "user_hint";
  data: Record<string, unknown>;
  afterMessageCount: number;
}

interface FakeSession {
  id: string;
  specialist: "general" | "research";
  messages: string[];
  markers: FakeMarker[];
}

interface HarnessState {
  session: FakeSession;
  busy: boolean;
  claimAllowed: boolean;
  queue: string[];
  events: string[];
  seenSessions: FakeSession[];
  runErrors: string[];
  failurePoint?: "switch" | "marker" | "hint" | "prompt";
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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startRouteHarness(
  mode: "code" | "chat",
  overrides: Partial<Pick<HarnessState, "busy" | "claimAllowed" | "failurePoint">> = {},
): Promise<{ baseUrl: string; state: HarnessState }> {
  const state: HarnessState = {
    session: {
      id: "logical-session-1",
      specialist: "general",
      messages: [],
      markers: [],
    },
    busy: overrides.busy ?? false,
    claimAllowed: overrides.claimAllowed ?? true,
    queue: [],
    events: [],
    seenSessions: [],
    runErrors: [],
    ...(overrides.failurePoint ? { failurePoint: overrides.failurePoint } : {}),
  };

  const fail = (point: NonNullable<HarnessState["failurePoint"]>): void => {
    if (state.failurePoint === point) throw new Error(`${point} failed`);
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (method === "GET" && pathname === "/commands") {
      const chatCommands = appSidecarChatCommandsResponse(mode);
      json(
        res,
        200,
        chatCommands ?? {
          commands: [{ name: "commit", aliases: [], description: "Commit changes" }],
        },
      );
      return;
    }

    if (method === "GET" && pathname === "/history") {
      const history = state.session.messages.map((modelText, index) => {
        const hint = state.session.markers.find(
          (marker) => marker.kind === "user_hint" && marker.afterMessageCount === index + 1,
        );
        const command = hint?.data.command;
        return {
          role: "user",
          text: typeof command === "string" ? command : modelText,
          ...(typeof command === "string" ? { command: true } : {}),
        };
      });
      json(res, 200, { history });
      return;
    }

    if (method === "POST" && pathname === "/prompt") {
      void readJson(req).then(async (body) => {
        const text = typeof body.text === "string" ? body.text : "";
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        const handled = await handleAppSidecarChatResearchPrompt({
          mode,
          text,
          attachmentCount: attachments.length,
          busy: state.busy,
          claimStart: () => state.claimAllowed,
          respond: (response) => json(res, response.status, response.body),
          runAgent: async (_displayText, run) => {
            try {
              await run();
            } catch (error) {
              state.runErrors.push(error instanceof Error ? error.message : String(error));
            }
          },
          operations: {
            session: state.session,
            switchToResearch: async (session) => {
              state.seenSessions.push(session);
              state.events.push("switch:research");
              fail("switch");
              session.specialist = "research";
            },
            persistAgentHandoff: async (session, chatAgent) => {
              state.seenSessions.push(session);
              state.events.push(`marker:${chatAgent}`);
              fail("marker");
              session.markers.push({
                kind: "agent_handoff",
                data: { chatAgent },
                afterMessageCount: session.messages.length,
              });
            },
            persistUserHint: async (session, displayText) => {
              state.seenSessions.push(session);
              state.events.push(`hint:${displayText}`);
              fail("hint");
              session.markers.push({
                kind: "user_hint",
                data: { command: displayText },
                afterMessageCount: session.messages.length + 1,
              });
            },
            prompt: async (session, continuationPrompt) => {
              state.seenSessions.push(session);
              state.events.push("prompt:hidden");
              fail("prompt");
              session.messages.push(continuationPrompt);
            },
          },
        });
        if (handled) return;

        if (state.busy) {
          state.queue.push(text);
          json(res, 202, { queued: true, count: state.queue.length });
          return;
        }
        state.session.messages.push(text);
        json(res, 202, { queued: false, count: 0 });
      });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, state };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

async function postPrompt(
  baseUrl: string,
  text: string,
  attachments: unknown[] = [],
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, attachments }),
  });
  return { status: response.status, body: await response.json() };
}

describe("app-sidecar chat Research HTTP routes", () => {
  it("advertises only /research in chat while preserving coding commands", async () => {
    const chat = await startRouteHarness("chat");
    const coding = await startRouteHarness("code");

    expect(await getJson(chat.baseUrl, "/commands")).toEqual({
      status: 200,
      body: {
        commands: [
          {
            name: "research",
            aliases: [],
            description: "Research this conversation and draft net-new Roadmap phases",
            usage: "/research [optional focus]",
            source: "built-in",
          },
        ],
      },
    });
    expect(await getJson(coding.baseUrl, "/commands")).toEqual({
      status: 200,
      body: {
        commands: [{ name: "commit", aliases: [], description: "Commit changes" }],
      },
    });
  });

  it("runs the same-session switch, marker, hint, and hidden prompt in order", async () => {
    const { baseUrl, state } = await startRouteHarness("chat");

    expect(await postPrompt(baseUrl, "  /research   citations and UX  ")).toEqual({
      status: 202,
      body: { queued: false, count: 0 },
    });
    expect(state.queue).toEqual([]);
    expect(state.session.specialist).toBe("research");
    expect(state.events).toEqual([
      "switch:research",
      "marker:research",
      "hint:/research citations and UX",
      "prompt:hidden",
    ]);
    expect(state.seenSessions).toEqual([
      state.session,
      state.session,
      state.session,
      state.session,
    ]);
    expect(state.session.messages).toHaveLength(1);
    expect(state.session.messages[0]).toContain(
      "<research_focus>citations and UX</research_focus>",
    );
    expect(state.session.messages[0]).not.toContain("/research citations and UX");
    expect(await getJson(baseUrl, "/history")).toEqual({
      status: 200,
      body: {
        history: [{ role: "user", text: "/research citations and UX", command: true }],
      },
    });
  });

  it.each([
    {
      name: "attachments before busy state",
      busy: true,
      attachments: [{ name: "notes.txt" }],
      error: "research_attachments_unsupported",
    },
    { name: "busy state", busy: true, attachments: [], error: "research_session_busy" },
  ])("rejects $name before mutation or queueing", async ({ busy, attachments, error }) => {
    const { baseUrl, state } = await startRouteHarness("chat", { busy });

    const response = await postPrompt(baseUrl, "/research roadmap", attachments);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error });
    expect(state.events).toEqual([]);
    expect(state.session.markers).toEqual([]);
    expect(state.session.messages).toEqual([]);
    expect(state.queue).toEqual([]);
  });

  it("rejects a lost start claim instead of silently queueing", async () => {
    const { baseUrl, state } = await startRouteHarness("chat", { claimAllowed: false });

    const response = await postPrompt(baseUrl, "/research");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "research_session_busy" });
    expect(state.events).toEqual([]);
    expect(state.queue).toEqual([]);
  });

  it.each(["switch", "marker", "hint", "prompt"] as const)(
    "surfaces a %s failure and does not execute later handoff operations",
    async (failurePoint) => {
      const { baseUrl, state } = await startRouteHarness("chat", { failurePoint });

      expect(await postPrompt(baseUrl, "/research")).toEqual({
        status: 202,
        body: { queued: false, count: 0 },
      });

      const sequence = ["switch:research", "marker:research", "hint:/research", "prompt:hidden"];
      const failureIndex = ["switch", "marker", "hint", "prompt"].indexOf(failurePoint);
      expect(state.events).toEqual(sequence.slice(0, failureIndex + 1));
      expect(state.runErrors).toEqual([`${failurePoint} failed`]);
      expect(state.session.messages).toEqual([]);
      expect(state.queue).toEqual([]);
    },
  );

  it("leaves ordinary chat, near-match slash text, and coding /research on normal paths", async () => {
    const chat = await startRouteHarness("chat");
    const coding = await startRouteHarness("code");

    expect(await postPrompt(chat.baseUrl, "Please research this")).toMatchObject({
      status: 202,
      body: { queued: false },
    });
    expect(await postPrompt(chat.baseUrl, "/researcher roadmap")).toMatchObject({
      status: 202,
      body: { queued: false },
    });
    expect(await postPrompt(coding.baseUrl, "/research roadmap")).toMatchObject({
      status: 202,
      body: { queued: false },
    });

    expect(chat.state.events).toEqual([]);
    expect(chat.state.session.messages).toEqual(["Please research this", "/researcher roadmap"]);
    expect(coding.state.events).toEqual([]);
    expect(coding.state.session.messages).toEqual(["/research roadmap"]);
  });
});
