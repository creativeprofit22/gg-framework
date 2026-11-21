import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  isGitBranchCreateResponse,
  isGitBranchListResponse,
  isGitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Boots the REAL app sidecar daemon and drives it over HTTP, because the bug
 * being covered is cross-session: connecting a provider in one window has to
 * refresh the model picker in every window. A per-session unit test cannot see
 * that — the whole failure lives in which SSE streams receive the frame.
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

let tmpHome: string;
let tmpProject: string;
type Daemon = ChildProcessByStdio<null, Readable, Readable>;
let daemon: Daemon | undefined;
let port = 0;
const daemonAuthToken = "test-daemon-bootstrap-token";
let token = "";
const openStreams: http.IncomingMessage[] = [];
// Removed after the daemon exits: Windows refuses to delete a folder it still has open.
const extraDirs: string[] = [];

/** Start the daemon on an ephemeral port and wait for its listening handshake. */
async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, [SIDECAR], {
    cwd: tmpProject,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      GG_APP_CWD: tmpProject,
      GG_APP_PORT: "0",
      GG_APP_AUTH_TOKEN: daemonAuthToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never listened: ${out}`)), 60_000);
    daemon!.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /GG_APP_LISTENING (\d+) (\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        token = match[2];
        resolve(Number(match[1]));
      }
    });
    daemon!.on("error", reject);
    daemon!.on("exit", (code) => reject(new Error(`daemon exited (${code}): ${out}`)));
  });
}

function request(
  method: string,
  urlPath: string,
  opts: {
    session?: string;
    body?: unknown;
    daemonAuth?: boolean;
    token?: string;
    host?: string;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(opts.session ? { "x-gg-session": opts.session } : {}),
          ...(opts.daemonAuth ? { "x-gg-daemon-token": daemonAuthToken } : {}),
          // Default to the real token; pass token: "" to exercise the 401 path.
          ...(opts.token !== undefined
            ? opts.token
              ? { "x-gg-token": opts.token }
              : {}
            : { "x-gg-token": token }),
          ...(opts.host ? { host: opts.host } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: {} });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a window's SSE stream and collect the events it receives. */
function openEventStream(session: string): Promise<{
  types: string[];
  events: { type: string; data: Record<string, unknown> }[];
  frames: { type: string; data?: Record<string, unknown> }[];
}> {
  return new Promise((resolve, reject) => {
    const types: string[] = [];
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/events?session=${session}`,
        method: "GET",
        headers: { "x-gg-token": token },
      },
      (res) => {
        openStreams.push(res);
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let split = buf.indexOf("\n\n");
          while (split !== -1) {
            const frame = buf.slice(0, split);
            buf = buf.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6)) as {
                  type: string;
                  data: Record<string, unknown>;
                };
                types.push(event.type);
                events.push(event);
              } catch {
                // Non-JSON keepalives are not events.
              }
            }
            split = buf.indexOf("\n\n");
          }
        });
        resolve({ types, events, frames: events });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function createSession(): Promise<string> {
  const res = await request("POST", "/session", {
    body: { mode: "code", cwd: tmpProject },
    daemonAuth: true,
  });
  expect(res.status).toBe(200);
  return res.json.sessionId as string;
}

async function writeOpenAIOAuth(): Promise<void> {
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      // The ChatGPT plan sign-in has its own slot; an OAuth shape under `openai` is retired.
      "openai-chatgpt": {
        ["access" + "Token"]: "oauth-access",
        ["refresh" + "Token"]: "oauth-refresh",
        expiresAt: Date.now() + 3_600_000,
        accountId: "account-live",
      },
    }),
  );
}

async function writeOpenAIApiKey(): Promise<void> {
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      openai: {
        ["access" + "Token"]: "api-key",
        ["refresh" + "Token"]: "",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-models-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-models-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  // No auth.json: the daemon is boot-tolerant when logged out, which is exactly
  // the state a user is in right before they connect their first provider.
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ autoCompact: false }),
  );
  await startDaemon();
});

afterEach(async ({ task }) => {
  for (const stream of openStreams.splice(0)) stream.destroy();
  const runningDaemon = daemon;
  daemon = undefined;
  if (runningDaemon && runningDaemon.exitCode === null && runningDaemon.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      runningDaemon.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      runningDaemon.kill("SIGKILL");
    });
  }
  // A daemon-side hang (seen once on Windows CI) leaves no trace in the test output.
  if (task.result?.state === "fail") await printSidecarLogTail();
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  await fs.rm(tmpHome, removeOptions);
  await fs.rm(tmpProject, removeOptions);
  for (const dir of extraDirs.splice(0)) await fs.rm(dir, removeOptions);
});

describe("daemon session authorization", () => {
  it("rejects session minting without the native bootstrap credential", async () => {
    const response = await request("POST", "/session", {
      body: { mode: "code", cwd: tmpProject },
    });
    expect(response).toEqual({
      status: 401,
      json: { error: "daemon authentication required" },
    });
  });
});
async function printSidecarLogTail(): Promise<void> {
  const logFile = path.join(tmpHome, ".gg", "gg-app-sidecar.log");
  const text = await fs.readFile(logFile, "utf-8").catch(() => "(no sidecar log)");
  console.error(`--- ${logFile} (last 200 lines) ---\n${text.split("\n").slice(-200).join("\n")}`);
}

describe("loopback daemon auth", () => {
  it("rejects requests without the per-launch token", async () => {
    const res = await request("POST", "/session", {
      body: { mode: "code", cwd: tmpProject },
      token: "",
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const res = await request("GET", "/progress", { token: "wrong-" + "token" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a non-loopback Host (DNS rebinding)", async () => {
    const res = await request("GET", "/progress", { host: "attacker.example" });
    expect(res.status).toBe(403);
  });
});

describe("a goal window reconnecting", () => {
  it("keeps the goal in the ready frame, as in GET /state", async () => {
    // Live bug: after a daemon restart the app swaps its state for the events
    // stream's "ready" frame, which had no `goal`, so a goal window turned
    // into a plain project screen.
    const goalDir = path.join(tmpHome, ".gg", "goals", "speed");
    await fs.mkdir(goalDir, { recursive: true });
    await fs.writeFile(
      path.join(goalDir, "goal.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "speed",
        name: "Speed",
        goal: "Make it fast",
        context: [],
        createdAt: "2026-10-11T00:00:00.000Z",
      }),
    );
    const created = await request("POST", "/session", {
      daemonAuth: true,
      body: { mode: "code", cwd: goalDir },
    });
    expect(created.status).toBe(200);
    const session = created.json.sessionId as string;
    // The app also keeps the conversation file, to reopen it after a restart.
    expect(typeof created.json.sessionPath).toBe("string");

    const stream = await openEventStream(session);
    await waitFor(() => stream.types.includes("ready"));
    const ready = stream.frames.find((frame) => frame.type === "ready");
    expect(ready?.data?.goal).toMatchObject({ id: "speed", name: "Speed" });
    // And the questions it can still answer, so stale cards from a dead run close.
    // Local Fork: open questions reconcile through its pendingAsks snapshot.
    expect(ready?.data?.pendingAsks).toEqual([]);
    const state = await request("GET", "/state", { session });
    expect(state.json.goal).toMatchObject({ id: "speed", name: "Speed" });
  });

  it("shows the attached project's uncommitted files, not the goal folder's", async () => {
    // Live bug: the goal window read git from its own folder under
    // ~/.gg/goals, so the titlebar never showed what the agent had changed.
    const project = path.join(tmpHome, "site");
    await fs.mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "a.txt"), "changed by the agent\n");
    await fs.writeFile(path.join(project, "b.txt"), "and this\n");
    const goalDir = path.join(tmpHome, ".gg", "goals", "site-speed");
    await fs.mkdir(goalDir, { recursive: true });
    await fs.writeFile(
      path.join(goalDir, "goal.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "site-speed",
        name: "Site speed",
        goal: "Make it fast",
        context: [{ path: project, kind: "folder" }],
        createdAt: "2026-10-11T00:00:00.000Z",
      }),
    );
    const created = await request("POST", "/session", {
      daemonAuth: true,
      body: { mode: "code", cwd: goalDir },
    });
    expect(created.status).toBe(200);
    // A busy machine can make the first git read miss its 2 s limit; the
    // sidecar then re-reads in the background, so poll briefly for the result.
    const sessionId = created.json.sessionId as string;
    let state = await request("GET", "/state", { session: sessionId });
    for (let i = 0; i < 40 && state.json.isGitRepo !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await request("GET", "/state", { session: sessionId });
    }
    expect(state.json.isGitRepo).toBe(true);
    expect(state.json.gitDirtyFileCount).toBe(2);
  });
});

describe("a window whose saved conversation is gone", () => {
  it("opens a fresh session instead of failing", async () => {
    // Live bug: after a restart the app asked to resume a deleted session
    // file; the create failed and the window had no session, so even its
    // goal list said "Couldn't load your goals".
    const gone = path.join(tmpHome, ".gg", "sessions", "deleted", "2026-10-11T00-00-00_gone.jsonl");
    const created = await request("POST", "/session", {
      daemonAuth: true,
      body: { mode: "code", cwd: tmpProject, sessionPath: gone },
    });
    expect(created.status).toBe(200);
    expect(typeof created.json.sessionId).toBe("string");
    expect(created.json.sessionPath).not.toBe(gone);
  });
});

describe("a model that spends real money", () => {
  /** Restart the daemon logged in to Anthropic, with fast mode saved as the default. */
  async function restartWithSavedPaidModel(): Promise<void> {
    const running = daemon;
    daemon = undefined;
    if (running && running.exitCode === null && running.signalCode === null) {
      await new Promise<void>((resolve) => {
        running.once("close", () => resolve());
        running.kill("SIGKILL");
      });
    }
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        anthropic: {
          accessToken: "sk-ant-api03-test",
          refreshToken: "fake-refresh",
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    );
    await fs.writeFile(
      path.join(tmpHome, ".gg", "settings.json"),
      JSON.stringify({
        autoCompact: false,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-5-5-fast",
      }),
    );
    await startDaemon();
  }

  it("never restores, follows into, or switches to it without explicit confirmation", async () => {
    await restartWithSavedPaidModel();
    const session = await createSession();

    // A saved paid default boots the standard model instead.
    const boot = await request("GET", "/state", { session });
    expect(boot.json.model).toBe("claude-opus-5-5");

    // Switching without the user's confirmation is refused, and nothing changes.
    const refused = await request("POST", "/model", {
      session,
      body: { model: "claude-opus-5-5-fast" },
    });
    expect(refused.status).toBe(409);
    expect(refused.json.requiresPaidConfirmation).toBe(true);
    expect((await request("GET", "/state", { session })).json.model).toBe("claude-opus-5-5");

    // With confirmation it switches, but only this session: Ken stays on the
    // standard model and the saved default is never the paid tier.
    const confirmed = await request("POST", "/model", {
      session,
      body: { model: "claude-opus-5-5-fast", confirmPaid: true },
    });
    expect(confirmed.status).toBe(200);
    const after = await request("GET", "/state", { session });
    expect(after.json.model).toBe("claude-opus-5-5-fast");
    expect(after.json.kenModel).toBe("claude-opus-5-5");
    const saved = JSON.parse(
      await fs.readFile(path.join(tmpHome, ".gg", "settings.json"), "utf-8"),
    ) as { defaultModel?: string };
    expect(saved.defaultModel).toBe("claude-opus-5-5");

    // Ken can't be pinned to it either.
    const kenPin = await request("POST", "/ken/model", {
      session,
      body: { model: "claude-opus-5-5-fast" },
    });
    expect(kenPin.status).toBe(400);
  }, 120_000);
});

describe("connecting a provider", () => {
  it("refreshes models in every window, not just the one that connected", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamA = await openEventStream(windowA);
    const streamB = await openEventStream(windowB);

    // Logged out: no cloud provider's models are offered yet. Local providers
    // (Ollama, LM Studio) need no auth and may already be running on this
    // machine, so exclude them — the assertion is about auth-gated models only.
    const before = await request("GET", "/models", { session: windowA });
    const beforeCloud = (before.json.models as { local?: boolean }[]).filter((m) => !m.local);
    expect(beforeCloud).toEqual([]);

    // Connect a provider from window A only.
    const connect = await request("POST", "/auth/apikey", {
      session: windowA,
      body: { provider: "xai", key: "sk-test-key" },
    });
    expect(connect.status).toBe(200);

    // Both windows must be told, because ~/.gg/auth.json is shared. Without the
    // fan-out, window B's picker stayed stale until the session was reopened.
    await waitFor(() => streamA.types.includes("models_change"));
    await waitFor(() => streamB.types.includes("models_change"));

    // And the refetch each window now performs actually returns the new models.
    const after = await request("GET", "/models", { session: windowB });
    const cloudModels = (after.json.models as { provider: string; local?: boolean }[]).filter(
      (m) => !m.local,
    );
    expect(cloudModels.length).toBeGreaterThan(0);
    expect(cloudModels.every((m) => m.provider === "xai")).toBe(true);
  }, 90_000);

  it("closes the login modal in every window via auth_done", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamA = await openEventStream(windowA);
    const streamB = await openEventStream(windowB);

    await request("POST", "/auth/apikey", {
      session: windowA,
      body: { provider: "xai", key: "sk-test-key" },
    });

    // auth_done closes the modal; auth_change refreshes the connection dots.
    // A second window sitting on the login screen needs both.
    await waitFor(() => streamA.types.includes("auth_done"));
    await waitFor(() => streamB.types.includes("auth_done"));
    await waitFor(() => streamA.types.includes("auth_change"));
    await waitFor(() => streamB.types.includes("auth_change"));
  }, 90_000);
});

describe("OpenAI auth-state fan-out", () => {
  it("updates every live pane and guards mutations after logout", async () => {
    await writeOpenAIOAuth();
    const windowA = await createSession();
    const windowB = await createSession();
    for (const session of [windowA, windowB]) {
      const switched = await request("POST", "/model", {
        session,
        body: { model: "gpt-6.2-astra" },
      });
      expect(switched.status).toBe(200);
    }
    const streamA = await openEventStream(windowA);
    const streamB = await openEventStream(windowB);
    await waitFor(() =>
      [streamA, streamB].every((stream) =>
        stream.events.some(
          (event) => event.type === "ready" && event.data.accountId === "account-live",
        ),
      ),
    );

    const logout = await request("POST", "/auth/logout", {
      session: windowA,
      body: { provider: "openai" },
    });
    expect(logout.status).toBe(200);
    await waitFor(() =>
      [streamA, streamB].every(
        (stream) =>
          stream.types.includes("auth_change") &&
          stream.types.includes("models_change") &&
          stream.events.some((event) => event.type === "extras" && event.data.accountId === null),
      ),
    );

    for (const [url, body] of [["/context-profile", { profile: "experimental" }]] as const) {
      const result = await request("POST", url, { session: windowB, body });
      expect(result.status).toBe(409);
    }
  }, 90_000);

  it("keeps Astra controls unavailable for stored API-key auth", async () => {
    await writeOpenAIApiKey();
    const windowA = await createSession();
    const windowB = await createSession();
    for (const session of [windowA, windowB]) {
      const switched = await request("POST", "/model", {
        session,
        body: { model: "gpt-6.2-astra" },
      });
      expect(switched.status).toBe(200);
      const stream = await openEventStream(session);
      await waitFor(() =>
        stream.events.some((event) => event.type === "ready" && event.data.accountId === null),
      );
    }

    for (const [url, body] of [["/context-profile", { profile: "experimental" }]] as const) {
      const result = await request("POST", url, { session: windowB, body });
      expect(result.status).toBe(409);
    }
  }, 90_000);
});

describe("OAuth login across windows", () => {
  /** Park a Continue with ChatGPT flow at its "paste the callback" step in one window. */
  async function startParkedLogin(session: string): Promise<{ types: string[] }> {
    const stream = await openEventStream(session);
    const started = await request("POST", "/auth/oauth/start", {
      session,
      body: { provider: "openai" },
    });
    expect(started.status).toBe(202);
    // The flow opens a browser URL, then blocks on the pasted code.
    await waitFor(() => stream.types.includes("auth_need_code"));
    return stream;
  }

  it("keeps login progress in the window that started it", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamB = await openEventStream(windowB);
    const streamA = await startParkedLogin(windowA);

    expect(streamA.types).toContain("auth_url");
    expect(streamA.types).toContain("auth_need_code");
    // Window B never pressed Connect — opening its browser or prompting it for
    // a code it does not have would be nonsense. Progress stays scoped.
    expect(streamB.types).not.toContain("auth_url");
    expect(streamB.types).not.toContain("auth_need_code");
  }, 90_000);

  it("refuses a second window's login for the same provider", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    await startParkedLogin(windowA);

    // Two flows for one provider means two browser tabs and two token
    // exchanges racing to write the same auth.json entry. The per-session
    // guard cannot see across windows; the daemon-wide one must.
    const second = await request("POST", "/auth/oauth/start", {
      session: windowB,
      body: { provider: "openai" },
    });
    expect(second.status).toBe(409);
    expect(String(second.json.error)).toContain("another window");
  }, 90_000);

  it("refuses a sign-in for a provider that connects with a key only", async () => {
    const windowA = await createSession();
    // xAI offers SuperGrok / X Premium only in partner apps: an API key is the way in.
    const other = await request("POST", "/auth/oauth/start", {
      session: windowA,
      body: { provider: "xai" },
    });
    expect(other.status).toBe(400);
  }, 90_000);

  it("reports a failed login only to the window that attempted it", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamB = await openEventStream(windowB);
    const streamA = await startParkedLogin(windowA);

    // A callback from another attempt fails the state check locally — no network needed.
    const sent = await request("POST", "/auth/oauth/code", {
      session: windowA,
      body: { code: "http://127.0.0.1:1455/auth/callback?code=bogus&state=mismatch" },
    });
    expect(sent.status).toBe(200);
    await waitFor(() => streamA.types.includes("auth_error"));

    // Window B attempted nothing, so it has no failure to report. Its modal
    // correctly still offers to connect.
    expect(streamB.types).not.toContain("auth_error");
  }, 90_000);

  it("frees the provider again after a failed login", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamA = await startParkedLogin(windowA);

    await request("POST", "/auth/oauth/code", {
      session: windowA,
      body: { code: "http://127.0.0.1:1455/auth/callback?code=bogus&state=mismatch" },
    });
    await waitFor(() => streamA.types.includes("auth_error"));

    // A failed attempt must release the daemon-wide guard, or the provider
    // would be permanently unloggable until the app restarts.
    const retry = await request("POST", "/auth/oauth/start", {
      session: windowB,
      body: { provider: "openai" },
    });
    expect(retry.status).toBe(202);
  }, 90_000);
});

/**
 * OpenAI takes the ChatGPT plan sign-in AND an API key: two independent
 * credentials. The app renders a per-method comparison and per-method
 * disconnect from this payload, so a single "connected" bit is not enough.
 */
describe("dual-auth providers (OAuth + API key)", () => {
  async function providerStatus(session: string, value: string): Promise<Record<string, unknown>> {
    const res = await request("GET", "/auth/status", { session });
    expect(res.status).toBe(200);
    const providers = res.json.providers as Record<string, unknown>[];
    const found = providers.find((p) => p.value === value);
    expect(found).toBeDefined();
    return found!;
  }

  it("offers OpenAI both methods, with guidance and the priority rule", async () => {
    const session = await createSession();
    const openai = await providerStatus(session, "openai");

    expect(openai.methods).toEqual(["oauth", "apikey"]);
    expect(openai.connected).toBe(false);
    expect(openai.connectedMethods).toEqual([]);
    // The UI cannot invent this copy — the choice changes what the user is billed.
    const guidance = openai.methodGuidance as { method: string; label: string }[];
    expect(guidance.map((g) => g.label)).toEqual(["Continue with ChatGPT", "OpenAI API key"]);
    expect(String(openai.priorityNote)).toMatch(/first/i);
    // Grok is key-only now.
    expect((await providerStatus(session, "xai")).methods).toEqual(["apikey"]);
  }, 90_000);

  it("reports which method is connected and which one requests will use", async () => {
    const session = await createSession();
    await request("POST", "/auth/apikey", {
      session,
      body: { provider: "openai", key: "sk-test-key" },
    });

    const openai = await providerStatus(session, "openai");
    expect(openai.connected).toBe(true);
    // Key only: it is both connected and active, and the plan is still on offer.
    expect(openai.connectedMethods).toEqual(["apikey"]);
    expect(openai.activeMethod).toBe("apikey");
    expect(openai.oauthExhaustedUntil).toBeUndefined();
  }, 90_000);

  it("disconnects one method without dropping the other", async () => {
    const session = await createSession();
    // Write both credentials directly: a sign-in needs a real browser, and
    // what matters here is the two-credential state the app has to manage.
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        openai: { accessToken: "key", refreshToken: "", expiresAt: Date.now() + 1_000_000 },
        "openai-chatgpt": {
          accessToken: "plan",
          refreshToken: "r",
          expiresAt: Date.now() + 1_000_000,
          accountId: "user-sub",
          clientId: "oaiapp_test",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    );

    const both = await providerStatus(session, "openai");
    expect(both.connectedMethods).toEqual(["oauth", "apikey"]);
    // Both on file → the plan is what actually gets used.
    expect(both.activeMethod).toBe("oauth");

    // Dropping a spent API key must not sign the user out of the plan.
    const out = await request("POST", "/auth/logout", {
      session,
      body: { provider: "openai", method: "apikey" },
    });
    expect(out.status).toBe(200);

    const after = await providerStatus(session, "openai");
    expect(after.connectedMethods).toEqual(["oauth"]);
    expect(after.connected).toBe(true);
  }, 90_000);

  it("asks to reconnect a retired sign-in and never counts it as a key", async () => {
    const session = await createSession();
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        openai: {
          accessToken: "codex",
          refreshToken: "r",
          expiresAt: Date.now() + 1_000_000,
          accountId: "acct",
        },
        gemini: { accessToken: "oauth", refreshToken: "r", expiresAt: Date.now() + 1_000_000 },
        "gemini-api": { accessToken: "k", refreshToken: "", expiresAt: Date.now() + 1_000_000 },
      }),
    );
    const openai = await providerStatus(session, "openai");
    expect(openai.connected).toBe(false);
    expect(openai.connectedMethods).toEqual([]);
    expect(String(openai.reauthMessage)).toMatch(/Continue with ChatGPT/);

    // Gemini is listed again, on its AI Studio key.
    const gemini = await providerStatus(session, "gemini");
    expect(gemini.methods).toEqual(["apikey"]);
    expect(gemini.connectedMethods).toEqual(["apikey"]);
    expect(String(gemini.reauthMessage)).toMatch(/Gemini API key/);

    // Dismissing removes only the retired entry.
    await request("POST", "/auth/logout", {
      session,
      body: { provider: "gemini", method: "legacy" },
    });
    const saved = JSON.parse(await fs.readFile(path.join(tmpHome, ".gg", "auth.json"), "utf-8"));
    expect(saved.gemini).toBeUndefined();
    expect(saved["gemini-api"]).toBeDefined();
  }, 90_000);

  it("marks models the connected keys can't run, with the key they need", async () => {
    const session = await createSession();
    const key = (accessToken: string) => ({
      accessToken,
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
    });
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        moonshot: key("sk-moonshot"),
        xiaomi: { ...key("tp-key"), baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
      }),
    );
    const res = await request("GET", "/models", { session });
    const models = res.json.models as { id: string; unavailable?: string }[];
    const reason = (id: string) => models.find((m) => m.id === id)?.unavailable;
    // K2.8 Preview is served on the Kimi Code plan endpoint only.
    expect(reason("kimi-for-coding")).toBe("Needs a Kimi Code plan key");
    // UltraSpeed runs on API Credits only.
    expect(reason("mimo-v2.6-pro-ultraspeed")).toBe("Needs an API Credits key");
    // Models any connected key runs carry no reason.
    expect(reason("kimi-k3")).toBeUndefined();
    expect(reason("mimo-v2.6-flash")).toBeUndefined();
  }, 90_000);

  it("refuses to switch to a model the connected keys can't run", async () => {
    const session = await createSession();
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        moonshot: {
          accessToken: "sk-moonshot",
          refreshToken: "",
          expiresAt: Date.now() + 1_000_000,
        },
      }),
    );
    const before = (await request("GET", "/state", { session })).json.model;
    const refused = await request("POST", "/model", {
      session,
      body: { model: "kimi-for-coding" },
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("Needs a Kimi Code plan key");
    expect((await request("GET", "/state", { session })).json.model).toBe(before);
  }, 90_000);

  it("counts a stale Ollama credential only while Ollama serves models", async () => {
    const session = await createSession();
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        "local:ollama": {
          accessToken: "local",
          refreshToken: "",
          expiresAt: Date.now() + 1_000_000,
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      }),
    );
    // Holds whether or not this machine happens to be running Ollama.
    const local = await request("POST", "/local/scan", { session });
    const ollama = (
      local.json.endpoints as { id: string; reachable: boolean; models: unknown[] }[]
    ).find((e) => e.id === "ollama");
    const status = await request("GET", "/auth/status", { session });
    expect(status.json.localConnected).toBe(Boolean(ollama?.reachable && ollama.models.length));
  }, 90_000);

  it("counts a user-added local endpoint as connected without listing it as a tile", async () => {
    const session = await createSession();
    const added = await request("POST", "/local/endpoints", {
      session,
      body: { baseUrl: "http://127.0.0.1:9/v1", label: "Offline GW", apiKey: "sk-gateway" },
    });
    expect(added.status).toBe(200);
    const status = await request("GET", "/auth/status", { session });
    expect(status.status).toBe(200);
    expect(status.json.localConnected).toBe(true);
    const providers = status.json.providers as { value: string; connected: boolean }[];
    expect(providers.map((p) => p.value)).not.toContain("local");
    expect(providers.some((p) => p.connected)).toBe(false);
  }, 90_000);
});

describe("saved local model across restarts", () => {
  it("restores a local-only user's saved model once discovery finds it", async () => {
    const gateway = http.createServer((req, res) => {
      res.writeHead(req.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "free-model" }] }) : "{}");
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayPort = (gateway.address() as { port: number }).port;
    try {
      let session = await createSession();
      const added = await request("POST", "/local/endpoints", {
        session,
        body: { baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, label: "GW" },
      });
      expect(added.status).toBe(200);
      const saved = `local/${(added.json.endpoint as { id: string }).id}/free-model`;
      expect((await request("POST", "/model", { session, body: { model: saved } })).status).toBe(
        200,
      );

      const running = daemon!;
      await new Promise<void>((resolve) => {
        running.once("close", () => resolve());
        running.kill("SIGKILL");
      });
      await startDaemon();
      session = await createSession();

      // Boot picks a model before discovery; the saved one returns after the scan.
      let model = "";
      for (const deadline = Date.now() + 15_000; model !== saved && Date.now() < deadline;) {
        model = String((await request("GET", "/state", { session })).json.model);
        if (model !== saved) await new Promise((r) => setTimeout(r, 100));
      }
      expect(model).toBe(saved);
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 90_000);
});

describe("starting a goal by typing", () => {
  it("starts a briefing goal when the user types to start it, not when they ask (#133)", async () => {
    const session = await createSession();
    const created = await request("POST", "/goals", {
      session,
      body: { name: "Typed start", goal: "Write hello.txt", context: [tmpProject] },
    });
    expect(created.status).toBe(200);
    const goalDir = path.join(tmpHome, ".gg", "goals", (created.json.goal as { id: string }).id);
    const opened = await request("POST", "/session", {
      body: { mode: "code", cwd: goalDir },
      daemonAuth: true,
    });
    const goalSession = opened.json.sessionId as string;
    const startedAt = async (): Promise<unknown> =>
      (
        JSON.parse(await fs.readFile(path.join(goalDir, "goal.json"), "utf8")) as {
          startedAt?: unknown;
        }
      ).startedAt;

    await request("POST", "/prompt", {
      session: goalSession,
      body: { text: "Should we start the goal now?" },
    });
    expect(await startedAt()).toBeUndefined();

    await request("POST", "/prompt", {
      session: goalSession,
      body: { text: "Start the goal now" },
    });
    expect(typeof (await startedAt())).toBe("string");
  }, 90_000);
});

describe("a new window after picking a local model", () => {
  it("opens on the saved local model in a folder it has never seen (#133)", async () => {
    const gateway = http.createServer((req, res) => {
      res.writeHead(req.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "free-model" }] }) : "{}");
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayPort = (gateway.address() as { port: number }).port;
    const otherFolder = await fs.mkdtemp(path.join(os.tmpdir(), "gg-other-folder-"));
    extraDirs.push(otherFolder);
    try {
      let session = await createSession();
      const added = await request("POST", "/local/endpoints", {
        session,
        body: { baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, label: "GW" },
      });
      const saved = `local/${(added.json.endpoint as { id: string }).id}/free-model`;
      expect((await request("POST", "/model", { session, body: { model: saved } })).status).toBe(
        200,
      );

      const running = daemon!;
      await new Promise<void>((resolve) => {
        running.once("close", () => resolve());
        running.kill("SIGKILL");
      });
      await startDaemon();
      // A goal window, or any project opened for the first time, has no per-folder pick.
      const opened = await request("POST", "/session", {
        body: { mode: "code", cwd: otherFolder },
        daemonAuth: true,
      });
      expect(opened.status).toBe(200);
      session = opened.json.sessionId as string;

      let model = "";
      for (const deadline = Date.now() + 15_000; model !== saved && Date.now() < deadline;) {
        model = String((await request("GET", "/state", { session })).json.model);
        if (model !== saved) await new Promise((r) => setTimeout(r, 100));
      }
      expect(model).toBe(saved);
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 90_000);
});

describe("a run started right at boot", () => {
  it("waits for the saved local model instead of running on the fallback (#133)", async () => {
    const chatModels: string[] = [];
    let slowModels = false;
    const gateway = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        // Slower than the prompt below, like a goal's kickoff beating the scan.
        setTimeout(
          () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: "free-model" }] }));
          },
          slowModels ? 700 : 0,
        );
        return;
      }
      if (req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          chatModels.push(String((JSON.parse(body) as { model?: unknown }).model));
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (d: unknown): void => void res.write(`data: ${JSON.stringify(d)}\n\n`);
          chunk({ id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
          chunk({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          res.end("data: [DONE]\n\n");
        });
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayPort = (gateway.address() as { port: number }).port;
    try {
      let session = await createSession();
      const added = await request("POST", "/local/endpoints", {
        session,
        body: { baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, label: "GW" },
      });
      const saved = `local/${(added.json.endpoint as { id: string }).id}/free-model`;
      expect((await request("POST", "/model", { session, body: { model: saved } })).status).toBe(
        200,
      );

      const running = daemon!;
      await new Promise<void>((resolve) => {
        running.once("close", () => resolve());
        running.kill("SIGKILL");
      });
      slowModels = true;
      await startDaemon();
      session = await createSession();
      expect((await request("POST", "/prompt", { session, body: { text: "hi" } })).status).toBe(
        202,
      );

      for (const deadline = Date.now() + 15_000; chatModels.length === 0;) {
        if (Date.now() > deadline) throw new Error("the prompt never reached the local model");
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(chatModels[0]).toBe("free-model");
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 90_000);
});

describe("a branch switched outside the agent", () => {
  function git(...args: string[]): void {
    execFileSync("git", ["-c", "user.name=GG Test", "-c", "user.email=test@example.com", ...args], {
      cwd: tmpProject,
      stdio: "ignore",
    });
  }
  function initRepo(): void {
    git("-c", "init.defaultBranch=main", "init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
  }

  it("reaches every window on the folder after one refresh", async () => {
    initRepo();
    const a = await createSession();
    const b = await createSession();
    const streamA = await openEventStream(a);
    const streamB = await openEventStream(b);
    await waitFor(() => streamA.types.includes("ready") && streamB.types.includes("ready"));
    expect((await request("GET", "/state", { session: a })).json.gitBranch).toBe("main");
    expect((await request("GET", "/state", { session: b })).json.gitBranch).toBe("main");

    git("switch", "-q", "-c", "feature");
    // Nothing re-reads the branch on its own.
    expect((await request("GET", "/state", { session: b })).json.gitBranch).toBe("main");

    const refreshed = await request("POST", "/git/refresh", { session: a });
    expect(refreshed.status).toBe(204);
    expect((await request("GET", "/state", { session: a })).json.gitBranch).toBe("feature");
    expect((await request("GET", "/state", { session: b })).json.gitBranch).toBe("feature");
    const sawFeature = (stream: Awaited<ReturnType<typeof openEventStream>>) =>
      stream.events.some((e) => e.type === "extras" && e.data.gitBranch === "feature");
    await waitFor(() => sawFeature(streamA) && sawFeature(streamB));
  });

  it("updates when the Git panel opens", async () => {
    initRepo();
    const session = await createSession();
    expect((await request("GET", "/state", { session })).json.gitBranch).toBe("main");

    git("switch", "-q", "-c", "panel-open");
    const overview = await request("GET", "/git/overview", { session });
    expect(overview.status).toBe(200);
    let state = await request("GET", "/state", { session });
    for (let i = 0; i < 40 && state.json.gitBranch !== "panel-open"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await request("GET", "/state", { session });
    }
    expect(state.json.gitBranch).toBe("panel-open");
  });

  it("lists branches for the branch switcher", async () => {
    const session = await createSession();
    const outside = await request("GET", "/git/branches", { session });
    expect(outside.status).toBe(200);
    expect(outside.json).toEqual({ status: "not-a-repo" });

    initRepo();
    git("branch", "feature/one");
    git("branch", "feature/two");
    git("branch", "other");
    const all = await request("GET", "/git/branches", { session });
    expect(all.status).toBe(200);
    expect(isGitBranchListResponse(all.json)).toBe(true);
    expect(all.json).toMatchObject({
      status: "ok",
      current: { name: "main", detached: false },
      hasCommits: true,
      remote: null,
      defaultBranch: { name: "main", source: "fallback" },
      localTotal: 4,
      remoteOnly: [],
      truncated: false,
    });
    expect((all.json.local as Array<{ name: string }>)[0]!.name).toBe("main");

    const searched = await request("GET", "/git/branches?q=%20FEATURE%20&limit=1", { session });
    expect(searched.status).toBe(200);
    expect(searched.json).toMatchObject({ localTotal: 2, truncated: true });
    expect(searched.json.local as unknown[]).toHaveLength(1);

    const junkLimit = await request("GET", "/git/branches?limit=abc", { session });
    expect(junkLimit.json).toMatchObject({ localTotal: 4, truncated: false });
    expect(junkLimit.json.local as unknown[]).toHaveLength(4);
  });

  it("switches the branch from the app and tells every window on the folder", async () => {
    const outsider = await createSession();
    const outside = await request("POST", "/git/switch", {
      session: outsider,
      body: { branch: "main" },
    });
    expect(outside.status).toBe(200);
    expect(outside.json).toEqual({ status: "not-a-repo" });

    initRepo();
    git("branch", "feature");
    const a = await createSession();
    const b = await createSession();
    const streamA = await openEventStream(a);
    const streamB = await openEventStream(b);
    await waitFor(() => streamA.types.includes("ready") && streamB.types.includes("ready"));

    const badName = await request("POST", "/git/switch", { session: a, body: { branch: "-x" } });
    expect(badName.status).toBe(400);
    expect(typeof badName.json.error).toBe("string");
    expect((await request("POST", "/git/switch", { session: a, body: {} })).status).toBe(400);

    const switched = await request("POST", "/git/switch", {
      session: a,
      body: { branch: "feature" },
    });
    expect(switched.status).toBe(200);
    expect(isGitBranchSwitchResponse(switched.json)).toBe(true);
    expect(switched.json).toEqual({
      status: "switched",
      from: "main",
      to: "feature",
      trackedRemote: null,
      carriedChanges: false,
    });
    const sawFeature = (stream: Awaited<ReturnType<typeof openEventStream>>) =>
      stream.events.some((e) => e.type === "extras" && e.data.gitBranch === "feature");
    await waitFor(() => sawFeature(streamA) && sawFeature(streamB));
    expect((await request("GET", "/state", { session: b })).json.gitBranch).toBe("feature");
  });

  it("creates a branch from the app, checks names first and tells every window", async () => {
    initRepo();
    git("branch", "taken");
    const a = await createSession();
    const b = await createSession();
    const streamA = await openEventStream(a);
    const streamB = await openEventStream(b);
    await waitFor(() => streamA.types.includes("ready") && streamB.types.includes("ready"));
    const create = (body: unknown) => request("POST", "/git/branches/create", { session: a, body });

    expect((await create({})).status).toBe(400);
    for (const [body, status] of [
      [{ branch: "fresh", checkOnly: true }, "available"],
      [{ branch: "a b", checkOnly: true }, "invalid"],
      [{ branch: "taken", checkOnly: true }, "taken"],
      [{ branch: "taken" }, "taken"],
      [{ branch: "-x" }, "invalid"],
    ] as const) {
      const checked = await create(body);
      expect(checked.status).toBe(200);
      expect(isGitBranchCreateResponse(checked.json)).toBe(true);
      expect(checked.json.status).toBe(status);
    }
    const headNow = () =>
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: tmpProject,
        encoding: "utf8",
      }).trim();
    expect(headNow()).toBe("main");

    const created = await create({ branch: "fresh" });
    expect(created.status).toBe(200);
    expect(created.json).toEqual({
      status: "created",
      from: "main",
      to: "fresh",
      carriedChanges: false,
    });
    expect(headNow()).toBe("fresh");
    const sawFresh = (stream: Awaited<ReturnType<typeof openEventStream>>) =>
      stream.events.some((e) => e.type === "extras" && e.data.gitBranch === "fresh");
    await waitFor(() => sawFresh(streamA) && sawFresh(streamB));
    expect((await request("GET", "/state", { session: b })).json.gitBranch).toBe("fresh");
  });

  it("refuses a new prompt while a branch switch is still checking out", async () => {
    initRepo();
    git("branch", "feature");
    const gitDir = path.join(tmpProject, ".git");
    const started = path.join(gitDir, "switch-started");
    const release = path.join(gitDir, "switch-release");
    // A slow post-checkout hook holds the switch open, like a large checkout or LFS.
    await fs.writeFile(
      path.join(gitDir, "hooks", "post-checkout"),
      "#!/bin/sh\n: > .git/switch-started\nwhile [ ! -f .git/switch-release ]; do sleep 0.1; done\n",
      { mode: 0o755 },
    );
    const a = await createSession();
    const b = await createSession();
    const streamB = await openEventStream(b);
    await waitFor(() => streamB.types.includes("ready"));

    const switching = request("POST", "/git/switch", { session: a, body: { branch: "feature" } });
    try {
      await waitFor(() => existsSync(started), 30_000);
      const prompt = await request("POST", "/prompt", { session: b, body: { text: "hello" } });
      expect(prompt.status).toBe(409);
      expect(prompt.json).toEqual({
        error: "git_switch_running",
        message: "A branch switch is running in this project. Try again when it finishes.",
      });
      expect(streamB.types).not.toContain("run_start");
    } finally {
      await fs.writeFile(release, "");
    }
    const switched = await switching;
    expect(switched.status).toBe(200);
    expect(switched.json.status).toBe("switched");
  }, 90_000);

  it("refuses while a Run All sweep holds the folder outside a provider run", async () => {
    initRepo();
    git("branch", "feature");
    // A held model scan parks the sweep's first task before its provider run
    // starts, so only the sweep itself marks the window as working.
    let releaseModels = (): void => {};
    const modelsHeld = new Promise<void>((resolve) => (releaseModels = resolve));
    let holdModels = false;
    const gateway = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        void (holdModels ? modelsHeld : Promise.resolve()).then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "free-model" }] }));
        });
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayPort = (gateway.address() as { port: number }).port;
    try {
      let session = await createSession();
      const added = await request("POST", "/local/endpoints", {
        session,
        body: { baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, label: "GW" },
      });
      const saved = `local/${(added.json.endpoint as { id: string }).id}/free-model`;
      expect((await request("POST", "/model", { session, body: { model: saved } })).status).toBe(
        200,
      );
      const running = daemon!;
      await new Promise<void>((resolve) => {
        running.once("close", () => resolve());
        running.kill("SIGKILL");
      });
      holdModels = true;
      await startDaemon();
      session = await createSession();

      const tasksDir = path.join(
        tmpHome,
        ".gg-tasks",
        "projects",
        createHash("sha256").update(tmpProject).digest("hex").slice(0, 16),
      );
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(
        path.join(tasksDir, "tasks.json"),
        JSON.stringify([
          {
            id: "sweep-task-1",
            title: "Sweep task",
            prompt: "do the work",
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        ]),
      );
      const ran = await request("POST", "/tasks/run", { session, body: { all: true } });
      expect(ran.status).toBe(202);

      const switched = await request("POST", "/git/switch", {
        session,
        body: { branch: "feature" },
      });
      expect(switched.status).toBe(200);
      expect(isGitBranchSwitchResponse(switched.json)).toBe(true);
      expect(switched.json.status).toBe("busy");
      const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: tmpProject,
        encoding: "utf8",
      }).trim();
      expect(head).toBe("main");
    } finally {
      releaseModels();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 90_000);

  it("follows origin to another GitHub repo for every link", async () => {
    initRepo();
    git("remote", "add", "origin", "https://github.com/example-org/old-repo.git");
    const session = await createSession();
    let state = await request("GET", "/state", { session });
    expect(state.json.gitHubRepoUrl).toBe("https://github.com/example-org/old-repo");

    git("remote", "set-url", "origin", "https://github.com/example-org/new-repo.git");
    expect((await request("POST", "/git/refresh", { session })).status).toBe(204);
    // The switch to the new repo re-reads git after the refresh returns.
    for (
      let i = 0;
      i < 40 && state.json.gitHubRepoUrl !== "https://github.com/example-org/new-repo";
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await request("GET", "/state", { session });
    }
    expect(state.json.gitHubRepoUrl).toBe("https://github.com/example-org/new-repo");
    // Branch link and repo link name the same repo (the branch was never pushed).
    expect(String(state.json.gitHubBranchUrl ?? "")).not.toMatch(/old-repo/);

    // Moved off GitHub: no GitHub links at all, rather than the last repo's.
    git("remote", "set-url", "origin", "https://gitlab.com/example-org/new-repo.git");
    expect((await request("POST", "/git/refresh", { session })).status).toBe(204);
    for (let i = 0; i < 40 && state.json.gitHubRepoUrl !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await request("GET", "/state", { session });
    }
    expect(state.json.gitHubRepoUrl).toBeNull();
    expect(state.json.gitHubBranchUrl ?? null).toBeNull();
  });
});
