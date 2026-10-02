import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  connectToDevWebview,
  createIsolatedProfile,
  reserveHeldTcpPort,
  sanitizedSmokeEnvironment,
} from "./phase-25-windows-smoke-helpers.mjs";
import {
  processTreeSnapshot,
  readProcessTable,
  survivingProcessIds,
  terminateProcessTree,
} from "./workspace-shell-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const localForkIdentity = "com.ggcoder.local-fork";
const fixtureMode = "GG_CROSS_PANE_FIXTURE_MODE";

function canonicalPath(value) {
  const normalized = resolve(value).replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function readAudit(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(label, check, { timeoutMs = 120_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
  );
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

// Synthetic assistant reply with diff fences: short, long-line and collapsible.
function diffReplyText() {
  const short = [
    "diff --git a/src/greet.ts b/src/greet.ts",
    "index 3f2a1c0..9b7e4d2 100644",
    "--- a/src/greet.ts",
    "+++ b/src/greet.ts",
    "@@ -1,5 +1,6 @@",
    " export function greet(name: string): string {",
    "-  return 'Hello ' + name;",
    "+  const trimmed = name.trim();",
    "+  return `Hello, ${trimmed}!`;",
    " }",
  ].join("\n");
  const wide = [
    "@@ -10,2 +10,2 @@",
    `-const message = "${"a long removed line that keeps going ".repeat(6)}";`,
    `+const message = "${"a long added line that keeps going ".repeat(6)}";`,
  ].join("\n");
  const long = [
    "@@ -1,40 +1,40 @@",
    ...Array.from(
      { length: 40 },
      (_, i) => `${i % 3 === 0 ? "-" : i % 3 === 1 ? "+" : " "}line ${i}`,
    ),
  ].join("\n");
  return [
    "I changed the greeting to trim the name first:",
    "```diff\n" + short + "\n```",
    "A wide change that should scroll inside its block:",
    "```diff\n" + wide + "\n```",
    "A long change that should fold:",
    "```diff\n" + long + "\n```",
    "The same code as TypeScript for comparison:",
    "```ts\nexport function greet(name: string): string {\n  const trimmed = name.trim();\n  return `Hello, ${trimmed}!`;\n}\n```",
  ].join("\n\n");
}

function sessionState(sessionId, session) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: session.cwd,
    sessionId,
    sessionPath: null,
    messageCount: 0,
    mode: "code",
    chatAgent: "general",
    running: session.running,
    runState: session.running ? "running" : "idle",
    ready: true,
    planMode: false,
    pendingPlanReview:
      process.env.GG_LOCAL_LINK_FIXTURE === "1"
        ? {
            checkpointId: "local-link-plan",
            generation: 1,
            planPath: "plan.md",
            content: "[Plan file](same.txt)",
            contentHash: "fixture",
            state: "pending-review",
            reviewStatus: "unreviewed",
            feedback: null,
          }
        : null,
    thinkingLevel: null,
    supportedThinkingLevels: [],
    supportsVideo: false,
    autopilot: false,
    kenRunning: false,
    kenIsThinking: false,
    kenThinkingStartTs: null,
    kenThinkingAccumMs: 0,
    kenTokens: 0,
    contextWindow: 200000,
    contextTokens: 0,
    gitBranch: null,
    isGitRepo: false,
    gitDirtyFileCount: 0,
    tasks: [],
  };
}

// Scripted daemon event sequences for native state checks (GG_STATE_SCENE_FIXTURE=1).
// Prompt text `scene:<name>` selects one; `hold` steps give the driver time to capture.
const sceneDelay = (ms) => new Promise((done) => setTimeout(done, ms));

function stateScene(name) {
  const chunks = (text, size = 24) =>
    Array.from({ length: Math.ceil(text.length / size) }, (_, i) => [
      "text_delta",
      { text: text.slice(i * size, (i + 1) * size) },
    ]);
  const streamed =
    "## Streaming check\n\nThis reply is **arriving in pieces** with a list:\n\n- first item\n- second item\n\n```diff\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n```\n\nMIDSTREAM-MARKER and the rest keeps coming";
  switch (name) {
    case "stream":
      return [
        ["run_start", {}],
        ["thinking_delta", { text: "thinking" }],
        ["hold", 1500],
        ...chunks(streamed),
        ["hold", 5000],
        ["tool_call_start", { toolCallId: "t1", name: "bash", args: { command: "pnpm test" } }],
        ["hold", 2500],
        ["tool_call_end", { toolCallId: "t1", name: "bash", isError: false, result: "12 passed" }],
        [
          "tool_call_start",
          { toolCallId: "t2", name: "edit", args: { file_path: "src/missing.ts" } },
        ],
        [
          "tool_call_end",
          {
            toolCallId: "t2",
            name: "edit",
            isError: true,
            result: "File not found: src/missing.ts",
          },
        ],
        ...chunks("\n\nFinished after one failed edit. FINAL-MARKER"),
        ["turn_end", { usage: { outputTokens: 420 } }],
        ["agent_done", { totalUsage: { outputTokens: 420 } }],
        ["run_end", { outcome: "completed" }],
      ];
    case "fail":
      return [
        ["run_start", {}],
        ...chunks("Starting work before a provider failure…"),
        ["hold", 800],
        [
          "error",
          {
            headline: "The provider rejected the request",
            message: "429 Too Many Requests: rate limit reached for this model. FAIL-MARKER",
            guidance: "Wait a minute and try again, or switch models.",
          },
        ],
        ["run_end", { outcome: "failed" }],
      ];
    case "cancel":
      return [
        ["run_start", {}],
        ...chunks("Working on something long that will be stopped…"),
        ["hold", 1500],
        ["run_cancelling", {}],
        ["hold", 3000],
        ["run_end", { outcome: "cancelled", cancelled: true, runState: "idle" }],
      ];
    case "ask":
      return [
        ["run_start", {}],
        ...chunks("I need one decision first."),
        [
          "ask_user",
          {
            id: "fixture-ask",
            questions: [
              {
                id: "q1",
                kind: "choice",
                question: "Which layout should the report use? ASK-MARKER",
                detail: "This changes how results are grouped.",
                options: [
                  { label: "Group by file", recommended: true, hint: "Easier to scan" },
                  { label: "Group by severity" },
                ],
              },
            ],
          },
        ],
      ];
    case "compact":
      return [
        ["run_start", {}],
        ["compaction_start", {}],
        ["hold", 3000],
        ["compaction_end", { compacted: true, originalCount: 180, newCount: 24 }],
        ...chunks("Context was compacted. COMPACT-MARKER"),
        ["run_end", { outcome: "completed" }],
      ];
    case "extras": {
      const agent = (id, name, state, extra = {}) => [
        "subagent_state",
        {
          agent_id: id,
          task_name: name,
          state,
          started_at: 1,
          updated_at: 2,
          elapsed_ms: 4200,
          turn_count: 2,
          tool_use_count: 3,
          token_usage: { input: 1200, output: 300 },
          ...extra,
        },
      ];
      const imageFile = process.env.GG_STATE_SCENE_IMAGE;
      const png = imageFile
        ? readFileSync(imageFile, "utf8").trim()
        : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      return [
        ["run_start", {}],
        ...chunks("Checking a few integrations."),
        [
          "tool_call_start",
          { toolCallId: "m1", name: "mcp__github__create_issue", args: { title: "Fixture issue" } },
        ],
        ["hold", 800],
        [
          "tool_call_end",
          {
            toolCallId: "m1",
            name: "mcp__github__create_issue",
            isError: true,
            result: "MCP server 'github' error: 401 Bad credentials. MCPFAIL-MARKER",
          },
        ],
        agent("a1", "audit-styles", "running", { current_activity: "Reading App.css" }),
        agent("a2", "audit-tests", "running", { current_activity: "Running vitest" }),
        ["hold", 2500],
        agent("a1", "audit-styles", "completed", { output: "No issues" }),
        agent("a2", "audit-tests", "failed", { error: "Timed out after 60s" }),
        ["hold", 1200],
        [
          "tool_call_start",
          {
            toolCallId: "g1",
            name: "generate_image",
            args: { prompt: "a pigeon wearing a tiny hat" },
          },
        ],
        ["hold", 2500],
        [
          "tool_call_end",
          {
            toolCallId: "g1",
            name: "generate_image",
            isError: false,
            result: "Generated 1 image",
            details: {
              imagePreviews: [{ mediaType: "image/png", base64: png, path: "pigeon.png" }],
            },
          },
        ],
        ...chunks("Integrations checked. EXTRAS-MARKER"),
        [
          "plan_exit",
          {
            checkpointId: "fixture-plan",
            generation: 1,
            planPath: ".gg/plans/fixture.md",
            contentHash: "fixture",
            content: "# Fixture plan\n\n1. Tidy the header\n2. Add a test\n\nPLAN-MARKER",
          },
        ],
        ["run_end", { outcome: "completed" }],
      ];
    }
    case "drop":
      return [
        ["run_start", {}],
        ...chunks("Before the connection drops. "),
        ["hold", 800],
        ["drop", null],
        ["hold", 2500],
        ["await-stream", null],
        ["hold", 800],
        ...chunks("After reconnecting the reply continues. DROP-MARKER"),
        ["run_end", { outcome: "completed" }],
      ];
    case "long":
      return [
        ["run_start", {}],
        ...Array.from({ length: 40 }, (_, i) =>
          chunks(
            `Paragraph ${i + 1} of a long streaming reply that keeps arriving while panes move around.\n\n`,
            40,
          ),
        ).flat(),
        ...chunks("LONG-MARKER"),
        ["run_end", { outcome: "completed" }],
      ];
    default:
      return [];
  }
}

async function playStateScene(name, sessionId, session, audit) {
  audit({ action: "scene-start", scene: name, sessionId });
  for (const [type, data] of stateScene(name)) {
    if (type === "hold") {
      await sceneDelay(data);
      continue;
    }
    if (type === "drop") {
      for (const stream of session.streams ?? []) stream.end();
      session.streams?.clear();
      audit({ action: "scene-drop", sessionId });
      continue;
    }
    if (type === "await-stream") {
      for (let i = 0; i < 200 && !(session.streams?.size > 0); i += 1) await sceneDelay(50);
      audit({ action: "scene-reconnected", sessionId, streams: session.streams?.size ?? 0 });
      continue;
    }
    if (type === "run_end") session.running = false;
    const frame = `data: ${JSON.stringify({ sessionId, type, data })}\n\n`;
    for (const stream of session.streams ?? []) stream.write(frame);
    await sceneDelay(type === "text_delta" ? 60 : 150);
  }
  audit({ action: "scene-end", scene: name, sessionId });
}

function createFixtureServer({ auditFile, launchToken }) {
  const sessions = new Map();
  let nextSession = 1;
  let sequence = 0;
  const audit = (entry) =>
    appendFileSync(
      auditFile,
      `${JSON.stringify({ sequence: ++sequence, timestamp: Date.now(), ...entry })}\n`,
    );
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers["x-gg-token"] !== launchToken) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await readBody(request);
        const cwd = canonicalPath(typeof body.cwd === "string" ? body.cwd : process.cwd());
        const sessionId = `cross-pane-session-${nextSession++}`;
        sessions.set(sessionId, { cwd, running: false });
        audit({ action: "session-created", sessionId, cwd });
        json(response, 200, { sessionId });
        return;
      }
      const headerSession = request.headers["x-gg-session"];
      const sessionId =
        typeof headerSession === "string" ? headerSession : url.searchParams.get("session");
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!sessionId || !session) {
        json(response, 401, { error: "unknown fixture session" });
        return;
      }
      audit({
        action: "session-request",
        method: request.method,
        path: url.pathname,
        sessionId,
        cwd: session.cwd,
      });
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ sessionId, type: "ready", data: sessionState(sessionId, session) })}\n\n`,
        );
        session.streams ??= new Set();
        session.streams.add(response);
        response.on("close", () => session.streams?.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        json(response, 200, sessionState(sessionId, session));
        return;
      }
      if (request.method === "POST" && url.pathname === "/prompt") {
        const promptBody = await readBody(request);
        session.running = true;
        audit({ action: "prompt-held", sessionId, cwd: session.cwd });
        json(response, 202, { queued: false, count: 0 });
        const scene =
          process.env.GG_STATE_SCENE_FIXTURE === "1"
            ? /scene:([a-z]+)/.exec(String(promptBody.text ?? ""))?.[1]
            : undefined;
        if (scene) void playStateScene(scene, sessionId, session, audit);
        return;
      }
      if (request.method === "GET" && url.pathname === "/history") {
        const readingText = Array.from(
          { length: 100 },
          (_, index) =>
            `Sentence ${index}: the reader keeps this exact place while a long paragraph wraps across unequal pane widths.`,
        ).join(" ");
        const history =
          process.env.GG_PANE_READING_FIXTURE === "1"
            ? [
                { role: "user", text: "Reading-position fixture" },
                {
                  role: "assistant",
                  text: "",
                  mcpToolFailure: {
                    name: "mcp__fixture__tool",
                    result: "Tool evidence before the mentor paragraph.",
                  },
                },
                { role: "assistant", text: readingText, ken: true },
                {
                  role: "assistant",
                  text: "",
                  error: { scope: "error", headline: "Fixture error", message: readingText },
                },
                { role: "assistant", text: "", autopilot: { phase: "human", reason: readingText } },
                { role: "assistant", text: "Later normal assistant message.\n\n" + readingText },
              ]
            : process.env.GG_DIFF_REPLY_FIXTURE === "1"
              ? [
                  { role: "user", text: "Diff-reply fixture" },
                  { role: "assistant", text: diffReplyText() },
                ]
              : process.env.GG_LOCAL_LINK_FIXTURE === "1"
                ? [
                    { role: "assistant", text: "[Pane file](same.txt)" },
                    {
                      role: "assistant",
                      text: "",
                      toolImages: [
                        {
                          src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                          path: "same.txt",
                        },
                      ],
                    },
                  ]
                : [];
        json(response, 200, { history });
        return;
      }
      if (request.method === "GET" && url.pathname === "/models") {
        json(response, 200, { models: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/commands") {
        json(response, 200, { commands: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        json(response, 200, { tasks: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/progress") {
        json(response, 200, { xp: 0, level: 1, rank: "Newcomer", nextLevelXp: 100 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/reminders/reserve") {
        json(response, 200, { status: "none" });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/session") {
        sessions.delete(sessionId);
        audit({ action: "session-disposed", sessionId, cwd: session.cwd });
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/roadmap/phase-drafts/pending") {
        json(response, 200, { status: "ok", draft: null });
        return;
      }
      json(response, 200, {});
    } catch (error) {
      audit({
        action: "fixture-error",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) json(response, 500, { error: "fixture request failed" });
      else response.end();
    }
  });
  return { server, audit };
}

function safeEnvironment(paths, values) {
  const environment = sanitizedSmokeEnvironment(process.env, paths, values);
  for (const key of Object.keys(environment)) {
    if (
      /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS)(?:$|_)/i.test(
        key,
      )
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function parseArguments(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 2 || values[0] !== "--identity" || values[1] !== localForkIdentity) {
    throw new Error(`Usage: --identity ${localForkIdentity}`);
  }
  return { identity: values[1] };
}

export async function runCrossPaneProjectIsolationSmoke({
  identity,
  localLinks = false,
  readingAnchors = false,
  diffReplies = false,
  stateScenes = false,
  stateSceneImage,
  reuseDevServer = false,
  visual = false,
  beforeNativeStart,
  verifyWorkspace,
  onCleanup,
  appearanceTheme = process.env.GG_APPEARANCE_SMOKE_THEME,
}) {
  if (appearanceTheme !== undefined && appearanceTheme !== "dark" && appearanceTheme !== "light")
    throw new Error("Appearance smoke theme must be dark or light");
  if (appearanceTheme) {
    if (!reuseDevServer)
      throw new Error("Appearance checks require the verified normal-app server");
    await (await import("./appearance-dev.mjs")).verifyNormalServer();
  }
  if (process.platform !== "win32") throw new Error("Cross-pane developer smoke requires Windows");
  if (identity !== localForkIdentity)
    throw new Error("Only the Local Fork identity may run this smoke");

  const root = mkdtempSync(join(tmpdir(), "gg-cross-pane-projects-"));
  const projectsRoot = join(root, "projects");
  const projectA = join(projectsRoot, "project-a");
  const projectB = join(projectsRoot, "project-b");
  const projectC = join(projectsRoot, "project-c");
  const paths = createIsolatedProfile(root, projectA);
  mkdirSync(projectB, { recursive: true });
  if (localLinks) {
    for (const project of [projectA, projectB]) {
      writeFileSync(join(project, "same.txt"), `Pane-local file: ${project}\n`);
    }
  }
  const agentDir = join(paths.home, ".gg");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "gg-app.json"), `${JSON.stringify({ projectsRoot }, null, 2)}\n`);
  const auditFile = join(paths.audit, "cross-pane-project-isolation.jsonl");
  const devLog = join(paths.audit, "tauri-dev.log");
  let devConfig = "src-tauri/tauri.local.conf.json";
  if (reuseDevServer) {
    // Reuse only this checkout's current Vite source; never stop someone else's server.
    for (const source of ["AgentPane.tsx", "usePaneSwapViewState.ts", "useWorkspacePaneSwaps.ts"]) {
      const response = await fetch(`http://localhost:1420/src/${source}`, {
        signal: AbortSignal.timeout(5000),
      });
      const module = await response.text();
      const match = module.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/);
      const map = match ? JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) : null;
      if (
        !response.ok ||
        !map?.sourcesContent?.includes(readFileSync(join(appDir, "src", source), "utf8"))
      ) {
        throw new Error(`Existing dev server does not serve current ${source}`);
      }
    }
    const config = JSON.parse(readFileSync(join(appDir, devConfig), "utf8"));
    devConfig = join(paths.audit, "reuse-dev-server.json");
    writeFileSync(devConfig, JSON.stringify({ ...config, build: { beforeDevCommand: "" } }));
  }
  const portReservation = await reserveHeldTcpPort();
  const cdpPort = portReservation.port;
  await portReservation.release();
  const environment = safeEnvironment(paths, {
    GG_SIDECAR_PATH: fileURLToPath(import.meta.url),
    [fixtureMode]: "sidecar",
    GG_CROSS_PANE_FIXTURE_AUDIT: auditFile,
    GG_LOCAL_LINK_FIXTURE: localLinks ? "1" : "0",
    GG_PANE_READING_FIXTURE: readingAnchors ? "1" : "0",
    GG_DIFF_REPLY_FIXTURE: diffReplies ? "1" : "0",
    GG_STATE_SCENE_FIXTURE: stateScenes ? "1" : "0",
    ...(stateSceneImage ? { GG_STATE_SCENE_IMAGE: stateSceneImage } : {}),
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort),
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    GG_APP_DEV_SMOKE_WINDOW: visual ? "visible" : "minimized",
    GG_APP_CWD: projectA,
    COREPACK_HOME:
      process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node", "corepack"),
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_NETWORK: "0",
    CARGO_NET_OFFLINE: "true",
    CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup"),
  });
  const logFd = openSync(devLog, "a");
  let child;
  let client;
  let processIdentities = [];
  let failure;
  try {
    // A finite prebuild must settle before spawning Tauri or starting readiness clocks.
    if (beforeNativeStart)
      await beforeNativeStart(
        environment,
        JSON.parse(readFileSync(resolve(appDir, devConfig), "utf8")),
      );
    child = spawn(
      reuseDevServer ? process.execPath : (process.env.ComSpec ?? "cmd.exe"),
      reuseDevServer
        ? [join(appDir, "node_modules/@tauri-apps/cli/tauri.js"), "dev", "--config", devConfig]
        : ["/d", "/s", "/c", "pnpm exec tauri dev --config src-tauri/tauri.local.conf.json"],
      { cwd: appDir, env: environment, windowsHide: true, stdio: ["ignore", logFd, logFd] },
    );
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    if (!Number.isInteger(child.pid)) throw new Error("Tauri dev did not expose a process id");
    await waitFor(
      "fixture sidecar",
      () => {
        if (child.exitCode !== null) throw new Error(`Tauri dev exited ${child.exitCode}`);
        return readAudit(auditFile).find((entry) => entry.action === "fixture-listening");
      },
      { timeoutMs: 300_000 },
    );
    client = await connectToDevWebview(cdpPort, waitFor, (target) =>
      String(target.url).startsWith("http://localhost:1420"),
    );
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await waitFor("developer app", () =>
      client.evaluate(
        `location.origin === "http://localhost:1420" && document.readyState === "complete"`,
      ),
    );
    await waitFor("initial workspace", () =>
      client.evaluate(`Boolean(localStorage.getItem("gg-workspace-layout-recursive:main"))`),
    );
    if (appearanceTheme) {
      await client.evaluate(
        `localStorage.setItem('gg-app:appearance:v1', JSON.stringify({ theme: ${JSON.stringify(appearanceTheme)} })); true`,
      );
    }
    await client.evaluate(`(() => {
      localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify({
        version: 9,
        root: { type: "split", direction: "horizontal", size: { type: "ratio", value: 0.5 }, first: { type: "leaf", paneId: "primary" }, second: { type: "leaf", paneId: "pane-b" } },
        focusedPaneId: "primary",
        panes: {
          primary: { kind: "agent", mode: "code", cwd: ${JSON.stringify(projectA)}, sessionPath: null },
          "pane-b": { kind: "agent", mode: "code", cwd: ${JSON.stringify(projectB)}, sessionPath: null }
        }
      }));
      location.reload();
      return true;
    })()`);
    await waitFor("isolated A and B panes", () =>
      client.evaluate(`(() => {
        const normalize = (value) => value.replaceAll("\\\\", "/").toLowerCase();
        const a = normalize(document.querySelector("#workspace-pane-primary .chat-head-cwd")?.title ?? "");
        const b = normalize(document.querySelector("#workspace-pane-pane-b .chat-head-cwd")?.title ?? "");
        return a.startsWith(${JSON.stringify(canonicalPath(projectA))}) && b.startsWith(${JSON.stringify(canonicalPath(projectB))});
      })()`),
    );
    if (localLinks) {
      await waitFor("pane-local links and image cards", () =>
        client.evaluate(`
        document.querySelectorAll('.agent-pane a[href="same.txt"]').length === 4 &&
        document.querySelectorAll('.img-card[title="Open same.txt"]').length === 2
      `),
      );
      // Observe, but do not replace, the real native invocation and its result.
      await client.evaluate(`(() => {
        const original = window.fetch;
        window.__localLinkResults = [];
        window.fetch = async function(input, init) {
          const response = await original.call(this, input, init);
          if (String(input) === "http://ipc.localhost/open_project_path") {
            const { paneId, path } = JSON.parse(init.body);
            window.__localLinkResults.push({ paneId, path, ok: response.headers.get("Tauri-Response") === "ok" });
          }
          return response;
        };
      })()`);
      for (const paneId of ["pane-b", "primary"]) {
        await client.evaluate(
          `document.querySelector(${JSON.stringify(`#workspace-pane-${paneId} .plan-review-details summary`)}).click()`,
        );
        for (const selector of [
          '.assistant-text a[href="same.txt"]',
          '.plan-review-body a[href="same.txt"]',
          '.img-card[title="Open same.txt"]',
        ]) {
          await client.evaluate(
            `document.querySelector(${JSON.stringify(`#workspace-pane-${paneId} ${selector}`)}).click()`,
          );
        }
      }
      const results = await waitFor("native local file opening", async () => {
        const entries = await client.evaluate("window.__localLinkResults");
        return entries.length === 6 ? entries : null;
      });
      for (const paneId of ["primary", "pane-b"]) {
        if (
          results.filter(
            (entry) => entry.paneId === paneId && entry.path === "same.txt" && entry.ok,
          ).length !== 3
        ) {
          throw new Error(`Wrong native local-file destination: ${JSON.stringify(results)}`);
        }
      }
      process.stdout.write(
        "PANE-LOCAL LINKS DEV SMOKE PASS: real native open calls from both pane transcripts, plan links, and image cards; fixture daemon.\n",
      );
    }
    const initialSessions = await waitFor("A and B daemon sessions", () => {
      const entries = readAudit(auditFile).filter((entry) => entry.action === "session-created");
      const a = entries.findLast((entry) => entry.cwd === canonicalPath(projectA));
      const b = entries.findLast((entry) => entry.cwd === canonicalPath(projectB));
      return a && b ? { a: a.sessionId, b: b.sessionId } : null;
    });
    await client.evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_prompt", { paneId: "primary", text: "hold", attachments: [], meta: null })`,
    );
    await waitFor("held A prompt", () =>
      readAudit(auditFile).find(
        (entry) => entry.action === "prompt-held" && entry.sessionId === initialSessions.a,
      ),
    );
    await client.evaluate(`(() => {
      const pane = document.querySelector("#workspace-pane-pane-b");
      const back = pane?.querySelector('button[aria-label="Back to this project\\'s sessions"]');
      if (!back) throw new Error("Missing pane B project picker button");
      back.click();
      return true;
    })()`);
    await waitFor("pane B project picker", () =>
      client.evaluate(
        `Boolean([...document.querySelectorAll("#workspace-pane-pane-b button")].find((button) => button.textContent?.trim() === "+ New project"))`,
      ),
    );
    await client.evaluate(`(() => {
      const pane = document.querySelector("#workspace-pane-pane-b");
      [...pane.querySelectorAll("button")].find((button) => button.textContent?.trim() === "+ New project").click();
      return true;
    })()`);
    await waitFor("new project modal", () =>
      client.evaluate(
        `document.querySelector('.modal[role="dialog"] .modal-title')?.textContent?.trim() === "New project"`,
      ),
    );
    await client.evaluate(`(() => {
      const modal = document.querySelector('.modal[role="dialog"]');
      const input = modal.querySelector('input[placeholder="my-project"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Project C");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [...modal.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create").click();
      return true;
    })()`);
    const sessionC = await waitFor("project C daemon session", () =>
      readAudit(auditFile)
        .filter((entry) => entry.action === "session-created")
        .findLast((entry) => entry.cwd === canonicalPath(projectC)),
    );
    await waitFor("isolated displayed cwd", () =>
      client.evaluate(`(() => {
        const normalize = (value) => value.replaceAll("\\\\", "/").toLowerCase();
        const a = normalize(document.querySelector("#workspace-pane-primary .chat-head-cwd")?.title ?? "");
        const c = normalize(document.querySelector("#workspace-pane-pane-b .chat-head-cwd")?.title ?? "");
        return a.startsWith(${JSON.stringify(canonicalPath(projectA))}) && c.startsWith(${JSON.stringify(canonicalPath(projectC))});
      })()`),
    );
    const states = await client.evaluate(`Promise.all([
      window.__TAURI_INTERNALS__.invoke("agent_state", { paneId: "primary" }),
      window.__TAURI_INTERNALS__.invoke("agent_state", { paneId: "pane-b" })
    ]).then(([primary, secondary]) => ({ primary, secondary }))`);
    if (
      canonicalPath(states.primary.cwd) !== canonicalPath(projectA) ||
      states.primary.sessionId !== initialSessions.a ||
      states.primary.running !== true
    ) {
      throw new Error(`Primary pane lost A identity: ${JSON.stringify(states.primary)}`);
    }
    if (
      canonicalPath(states.secondary.cwd) !== canonicalPath(projectC) ||
      states.secondary.sessionId !== sessionC.sessionId
    ) {
      throw new Error(`Secondary pane did not bind C: ${JSON.stringify(states.secondary)}`);
    }
    const audit = readAudit(auditFile);
    const stateRequests = audit.filter(
      (entry) => entry.action === "session-request" && entry.path === "/state",
    );
    if (
      !stateRequests.some(
        (entry) => entry.sessionId === initialSessions.a && entry.cwd === canonicalPath(projectA),
      )
    ) {
      throw new Error("Primary state request was not routed through A's session");
    }
    if (
      audit.some(
        (entry) => entry.sessionId === initialSessions.a && entry.cwd === canonicalPath(projectC),
      )
    ) {
      throw new Error("A request was routed with C's session target");
    }
    if (
      !audit.some((entry) => entry.path === "/events" && entry.sessionId === initialSessions.a) ||
      !audit.some((entry) => entry.path === "/events" && entry.sessionId === sessionC.sessionId)
    ) {
      throw new Error("Pane-targeted event bridges were not established for A and C");
    }
    await verifyWorkspace?.({
      client,
      cdpPort,
      paths,
      projectA,
      projectB,
      projectC,
      readAudit: () => readAudit(auditFile),
    });
    process.stdout.write(
      `CROSS-PANE PROJECT ISOLATION DEV SMOKE PASS: ${JSON.stringify({ primary: initialSessions.a, secondary: sessionC.sessionId })}\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = { status: "running", observedProcesses: 0, survivors: [] };
    try {
      client?.close();
      if (Number.isInteger(child?.pid)) {
        processIdentities = processTreeSnapshot(await readProcessTable(), child.pid).identities;
        await terminateProcessTree(child.pid);
      }
      const survivors = processIdentities.length
        ? survivingProcessIds(processIdentities, await readProcessTable())
        : [];
      cleanup.observedProcesses = processIdentities.length;
      cleanup.survivors = survivors;
      if (survivors.length)
        throw new Error(`Fixture processes survived cleanup: ${survivors.join(", ")}`);
      cleanup.status = "passed";
    } catch (cleanupError) {
      cleanup.status = "failed";
      failure ??= cleanupError;
    }
    onCleanup?.(cleanup);
    closeSync(logFd);
    if (!failure) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  if (failure) {
    throw new Error(
      `${failure instanceof Error ? failure.message : String(failure)}\nFixture retained at ${root}\n${readFileSync(devLog, "utf8").slice(-4_000)}`,
    );
  }
}

async function runFixtureSidecar() {
  const auditFile = process.env.GG_CROSS_PANE_FIXTURE_AUDIT;
  const launchToken = process.env.GG_APP_TOKEN;
  if (!auditFile || !launchToken) throw new Error("Cross-pane fixture environment is incomplete");
  const fixture = createFixtureServer({ auditFile, launchToken });
  fixture.server.listen(Number(process.env.GG_APP_PORT ?? 0), "127.0.0.1", () => {
    const address = fixture.server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture sidecar did not bind a port");
    fixture.audit({ action: "fixture-listening", port: address.port });
    process.stdout.write(`GG_APP_LISTENING ${address.port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => fixture.server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env[fixtureMode] === "sidecar") {
    runFixtureSidecar().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else {
    try {
      runCrossPaneProjectIsolationSmoke(parseArguments(process.argv.slice(2))).catch((error) => {
        console.error(
          `CROSS-PANE PROJECT ISOLATION DEV SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
