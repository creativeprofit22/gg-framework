import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitChatResearchTransition,
  resolveChatResearchCommandRoute,
} from "./app-sidecar-chat-research-handoff.js";
import { appSidecarCodeCommandsResponse } from "./app-sidecar-command-listing.js";
import {
  appSidecarChatCommandsResponse,
  handleAppSidecarChatResearchPrompt,
} from "./app-sidecar-chat-research-route.js";
import { loadCustomCommands } from "./core/custom-commands.js";
import { useFakeHome } from "./test-support/fake-home.js";

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
  customExpansions: string[];
  failurePoint?: "switch" | "marker" | "hint" | "prompt";
}

const openServers: http.Server[] = [];

function isFetchForbiddenPortError(error: unknown): boolean {
  return (
    error instanceof TypeError && error.cause instanceof Error && error.cause.message === "bad port"
  );
}

async function closeTestServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listenOnFetchCompatiblePort(server: http.Server): Promise<string> {
  while (true) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const candidateBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const probe = await fetch(`${candidateBaseUrl}/__fixture-port-check`);
      await probe.body?.cancel();
      return candidateBaseUrl;
    } catch (error) {
      await closeTestServer(server);
      if (!isFetchForbiddenPortError(error)) throw error;
    }
  }
}

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
  cwd = process.cwd(),
  expandCustomCommands = false,
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
    customExpansions: [],
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
          commands: [
            {
              name: "commit",
              aliases: [],
              description: "Commit changes",
              input: { text: "optional", references: "optional", attachments: "optional" },
              source: "built-in",
            },
          ],
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
        const route = resolveChatResearchCommandRoute({
          mode,
          text,
          attachmentCount: attachments.length,
          busy: state.busy,
        });
        const handled = await handleAppSidecarChatResearchPrompt({
          route,
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
            commitResearchTransition: (session) =>
              commitChatResearchTransition({
                session,
                previousAgent: session.specialist,
                researchAgent: "research" as const,
                switchAgent: async (active, nextAgent) => {
                  state.seenSessions.push(active);
                  state.events.push(`switch:${nextAgent}`);
                  const changed = active.specialist !== nextAgent;
                  active.specialist = nextAgent;
                  if (nextAgent === "research") fail("switch");
                  return changed;
                },
                persistAgentHandoff: async (active) => {
                  state.seenSessions.push(active);
                  state.events.push("marker:research");
                  fail("marker");
                  active.markers.push({
                    kind: "agent_handoff",
                    data: { chatAgent: "research" },
                    afterMessageCount: active.messages.length,
                  });
                },
                onCommitted: () => state.events.push("publish:research"),
              }),
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

        const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
        const customCommand =
          expandCustomCommands && match
            ? (await loadCustomCommands(cwd)).find((command) => command.name === match[1])
            : undefined;
        const expandedText = customCommand
          ? `${customCommand.prompt}${match?.[2] ? `\n\n## User Instructions\n\n${match[2]}` : ""}`
          : text;
        if (customCommand) state.customExpansions.push(customCommand.name);

        if (state.busy) {
          state.queue.push(expandedText);
          json(res, 202, { queued: true, count: state.queue.length });
          return;
        }
        state.session.messages.push(expandedText);
        json(res, 202, { queued: false, count: 0 });
      });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  openServers.push(server);
  return { baseUrl: await listenOnFetchCompatiblePort(server), state };
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
            input: { text: "optional", references: "optional", attachments: "none" },
            source: "built-in",
          },
        ],
      },
    });
    expect(await getJson(coding.baseUrl, "/commands")).toEqual({
      status: 200,
      body: {
        commands: [
          {
            name: "commit",
            aliases: [],
            description: "Commit changes",
            input: { text: "optional", references: "optional", attachments: "optional" },
            source: "built-in",
          },
        ],
      },
    });
  });

  it("advertises /programmatic as fixed-input in coding discovery", async () => {
    const response = await appSidecarCodeCommandsResponse(process.cwd());
    expect(response.commands.find((command) => command.name === "programmatic")).toMatchObject({
      input: { text: "none", references: "none", attachments: "none" },
      source: "built-in",
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
      "publish:research",
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

  it("dispatches exact /research before a conflicting global custom command", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "research-command-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "research-command-project-"));
    const restoreHome = useFakeHome(fakeHome);
    try {
      const commandsDir = path.join(fakeHome, ".gg", "commands");
      await fs.mkdir(commandsDir, { recursive: true });
      await fs.writeFile(
        path.join(commandsDir, "research.md"),
        "CUSTOM RESEARCH TEMPLATE MUST NOT RUN",
      );
      expect(
        (await loadCustomCommands(cwd)).find((command) => command.name === "research")?.prompt,
      ).toBe("CUSTOM RESEARCH TEMPLATE MUST NOT RUN");

      const { baseUrl, state } = await startRouteHarness("chat", {}, cwd, true);
      expect(await postPrompt(baseUrl, "/research exact collision")).toEqual({
        status: 202,
        body: { queued: false, count: 0 },
      });

      expect(state.customExpansions).toEqual([]);
      expect(state.session.messages).toHaveLength(1);
      expect(state.session.messages[0]).toContain(
        "<research_focus>exact collision</research_focus>",
      );
      expect(state.session.messages[0]).not.toContain("CUSTOM RESEARCH TEMPLATE MUST NOT RUN");

      for (const nearMatch of ["/Research exact collision", "/researcher", "/res"]) {
        expect(await postPrompt(baseUrl, nearMatch)).toMatchObject({
          status: 202,
          body: { queued: false },
        });
      }
      expect(state.session.messages.slice(1)).toEqual([
        "/Research exact collision",
        "/researcher",
        "/res",
      ]);
      expect(state.customExpansions).toEqual([]);
    } finally {
      restoreHome();
      await Promise.all([
        fs.rm(fakeHome, { recursive: true, force: true }),
        fs.rm(cwd, { recursive: true, force: true }),
      ]);
    }
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
    "surfaces a %s failure without splitting live and restart agent state",
    async (failurePoint) => {
      const { baseUrl, state } = await startRouteHarness("chat", { failurePoint });

      expect(await postPrompt(baseUrl, "/research")).toEqual({
        status: 202,
        body: { queued: false, count: 0 },
      });

      const expectedEvents = {
        switch: ["switch:research", "switch:general"],
        marker: ["switch:research", "marker:research", "switch:general"],
        hint: ["switch:research", "marker:research", "publish:research", "hint:/research"],
        prompt: [
          "switch:research",
          "marker:research",
          "publish:research",
          "hint:/research",
          "prompt:hidden",
        ],
      };
      expect(state.events).toEqual(expectedEvents[failurePoint]);
      expect(state.runErrors).toEqual([`${failurePoint} failed`]);
      expect(state.session.messages).toEqual([]);
      expect(state.queue).toEqual([]);

      const restoredAgent = [...state.session.markers]
        .reverse()
        .find((marker) => marker.kind === "agent_handoff")?.data.chatAgent;
      const expectedAgent =
        failurePoint === "switch" || failurePoint === "marker" ? "general" : "research";
      expect(state.session.specialist).toBe(expectedAgent);
      expect(restoredAgent ?? "general").toBe(expectedAgent);
      expect(state.events.includes("publish:research")).toBe(expectedAgent === "research");
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
