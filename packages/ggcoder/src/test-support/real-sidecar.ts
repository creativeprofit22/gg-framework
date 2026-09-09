import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import type { OpenAICodexContextProfile } from "@kenkaiiii/gg-core/models";

// Deliberately narrow runtime boundary: the UI compiler must not compile the CLI's Ink tree.
export interface FixtureSessions {
  create(cwd: string, provider: Provider, model: string, options: {
    openAICodexContextProfile: OpenAICodexContextProfile;
  }): Promise<{ id: string; path: string }>;
  list(cwd: string): Promise<Array<{ id: string; path: string }>>;
  appendRequiredMessage(file: string, entry: {
    type: "message"; id: string; parentId: string | null; timestamp: string; message: Message;
  }): Promise<void>;
  appendRequiredEntry(file: string, entry: {
    type: "custom"; id: string; parentId: string | null; timestamp: string; kind: string; data: unknown;
  }): Promise<void>;
}

export interface RealSidecarEvent {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
}

/** Source-only HTTP seam: never launches a bundled or installed application. */
export async function withRealSidecar<T>(run: (fixture: {
  project: string;
  manager: FixtureSessions;
  request: (route: string, sessionId?: string, body?: unknown) => Promise<Response>;
  open: (sessionPath: string) => Promise<string>;
  subscribe: (sessionId: string, receive?: (event: RealSidecarEvent) => void) => Promise<{
    events: RealSidecarEvent[];
    waitFor: (type: string, count?: number) => Promise<RealSidecarEvent>;
  }>;
}) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-real-sidecar-"));
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  const streams: AbortController[] = [];
  const readers: Promise<void>[] = [];
  const token = randomUUID();
  const nativeToken = randomUUID();
  try {
    const project = path.join(home, "project");
    const agentDir = path.join(home, ".gg");
    await fs.mkdir(project);
    await fs.mkdir(agentDir);
    const credentials = { accessToken: "inert-fixture-credential", refreshToken: "", expiresAt: Date.now() + 3_600_000 };
    await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: credentials, openai: credentials }));
    // Allowlist OS essentials only: no provider keys, Node injection, or user MCP configuration.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"]) {
      const actual = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
      if (actual) env[key] = process.env[actual];
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, HOMEDRIVE: "", HOMEPATH: "",
      APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"),
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_DATA_HOME: path.join(home, "data"), GG_AGENT_DIR: agentDir, GG_APP_CWD: project,
      GG_APP_AUTH_TOKEN: nativeToken, GG_APP_TOKEN: token, GG_APP_PORT: "0",
      GG_DISABLE_TELEMETRY: "1", GG_APP_ORPHAN_CHECK_MS: "0",
    });
    // Keep filesystem URLs out of Vite's browser asset URL transform in the UI harness.
    const moduleUrl = import.meta.url;
    const require = createRequire(new URL("../../package.json", moduleUrl));
    const managerUrl = new URL("../core/session-manager.ts", moduleUrl).href;
    const { SessionManager } = await import(managerUrl) as {
      SessionManager: new (root: string) => FixtureSessions;
    };
    child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href,
      fileURLToPath(new URL("../app-sidecar.ts", moduleUrl))], {
      cwd: fileURLToPath(new URL("../../", moduleUrl)), env, stdio: ["pipe", "pipe", "pipe"],
    });
    closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    // Drain logs without retaining or printing launch credentials.
    child.stderr?.resume();
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Source sidecar startup timed out")), 30_000);
      const fail = () => { clearTimeout(timer); reject(new Error("Source sidecar failed to start")); };
      child!.once("error", fail);
      child!.once("exit", fail);
      let output = "";
      child!.stdout?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        const match = /GG_APP_LISTENING (\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = (sessionId?: string) => ({ "content-type": "application/json", "x-gg-token": token,
      ...(sessionId ? { "x-gg-session": sessionId } : { "x-gg-daemon-token": nativeToken }) });
    const request = (route: string, sessionId?: string, body?: unknown) => fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : "POST", headers: headers(sessionId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    return await run({ project, manager: new SessionManager(path.join(agentDir, "sessions")), request,
      async open(sessionPath) {
        const response = await request("/session", undefined, { cwd: project, sessionPath });
        if (!response.ok) throw new Error(`Session open failed: ${response.status}`);
        const body = await response.json() as { sessionId: string };
        if (typeof body.sessionId !== "string") throw new Error("Missing logical session ID");
        return body.sessionId;
      },
      async subscribe(sessionId, receive) {
        const controller = new AbortController();
        streams.push(controller);
        const startup = setTimeout(() => controller.abort(), 15_000);
        const response = await fetch(`${base}/events`, { headers: headers(sessionId), signal: controller.signal });
        clearTimeout(startup);
        if (!response.ok || !response.body) throw new Error("SSE subscription failed");
        const events: RealSidecarEvent[] = [];
        let failure: unknown;
        const reader = response.body.getReader();
        const reading = (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              buffer += decoder.decode(next.value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = /^data: ?(.+)$/m.exec(frame)?.[1];
                if (data) {
                  const event = JSON.parse(data) as RealSidecarEvent;
                  if (event.sessionId !== sessionId || typeof event.type !== "string" ||
                    !event.data || typeof event.data !== "object") throw new Error("Invalid SSE frame");
                  events.push(event);
                  receive?.(event);
                }
              }
            }
          } catch (error) { if (!controller.signal.aborted) failure = error; }
          finally { reader.releaseLock(); }
        })();
        readers.push(reading);
        const waitFor = async (type: string, count = 1) => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            if (failure) throw failure;
            const event = events.filter((entry) => entry.type === type)[count - 1];
            if (event) return event;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`SSE ${type} timed out`);
        };
        await waitFor("ready");
        return { events, waitFor };
      },
    });
  } finally {
    for (const controller of streams) controller.abort();
    if (child && closed) {
      child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Source sidecar shutdown timed out; fixture retained")), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    await Promise.all(readers);
    await fs.rm(home, { recursive: true, force: true });
  }
}
