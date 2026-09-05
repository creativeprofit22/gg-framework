/**
 * README screenshot harness.
 *
 * Boots the Vite dev server's webview in headless Chromium with a FAKE Tauri IPC
 * layer (`window.__TAURI_INTERNALS__`), so every screenshot is rendered from
 * synthetic demo data defined in this file. Nothing from `~/.gg` — no real
 * sessions, project paths, chat content, tokens, or account names — can ever
 * reach a committed image.
 *
 * Usage:
 *   pnpm --filter gg-app dev            # terminal 1 (http://localhost:1420)
 *   node gg-app/scripts/capture-screenshots.mjs
 *
 * Output: docs/screenshots/*.png (referenced by the root README).
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../docs/screenshots");
// Individual quadrants for the 4-up composite. Intermediate, not committed.
const tileDir = resolve(outDir, ".tiles");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function requireVisualFixtureUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`Visual fixtures require a loopback URL, received ${value}`);
  }
  return parsed.href;
}

const url = requireVisualFixtureUrl(process.env.GG_SHOT_URL ?? "http://localhost:1420");
const viewport = { width: 1440, height: 900 };

// ── Demo data ────────────────────────────────────────────────────────────────
// Deliberately fictional. Keep it that way.
const DEMO = {
  cwd: "/Users/demo/projects/aurora-store",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  projects: [
    { name: "aurora-store", path: "/Users/demo/projects/aurora-store" },
    { name: "pixel-pipeline", path: "/Users/demo/projects/pixel-pipeline" },
    { name: "rusty-parser", path: "/Users/demo/projects/rusty-parser" },
    { name: "landing-page", path: "/Users/demo/projects/landing-page" },
  ],
  sessions: [
    "Add checkout retry with idempotency keys",
    "Port the image resizer to sharp",
    "Fix flaky cart integration test",
  ],
};

const state = {
  provider: DEMO.provider,
  model: DEMO.model,
  cwd: DEMO.cwd,
  mode: "code",
  running: false,
  runState: "idle",
  thinkingLevel: "medium",
  supportedThinkingLevels: ["low", "medium", "high"],
  planMode: false,
  contextTokens: 48_210,
  contextWindow: 200000,
  gitBranch: "main",
  isGitRepo: true,
  gitDirtyFileCount: 3,
  gitHubIssues: 4,
  gitHubPRs: 1,
  gitHubRepoUrl: "https://github.com/demo/aurora-store",
  supportsVideo: false,
  autopilot: false,
  kenProvider: DEMO.provider,
  kenModel: DEMO.model,
  kenModelOverride: false,
  tasks: [],
};

const astraState = {
  ...state,
  provider: "openai",
  model: "gpt-6-astra",
  accountId: "fixture-account",
  thinkingLevel: "low",
  supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
};

export const astraVisualScenarios = [
  {
    name: "astra-stable-fast-off",
    state: {
      ...astraState,
      openAICodexContextProfile: "stable",
      openAICodexFast: false,
      contextTokens: 136_000,
      contextWindow: 272_000,
    },
    controls: "enabled",
  },
  {
    name: "astra-experimental-fast-on",
    state: {
      ...astraState,
      openAICodexContextProfile: "experimental",
      openAICodexFast: true,
      contextTokens: 741_200,
      contextWindow: 872_000,
    },
    controls: "enabled",
  },
  {
    name: "astra-running-disabled",
    state: {
      ...astraState,
      running: true,
      runState: "running",
      openAICodexContextProfile: "stable",
      openAICodexFast: true,
      contextTokens: 68_000,
      contextWindow: 272_000,
    },
    controls: "disabled",
  },
  {
    name: "astra-oauth-disconnected",
    state: {
      ...astraState,
      accountId: null,
      openAICodexContextProfile: "stable",
      openAICodexFast: false,
      contextTokens: 108_800,
      contextWindow: 272_000,
    },
    controls: "hidden",
  },
  {
    name: "astra-over-window",
    state: {
      ...astraState,
      openAICodexContextProfile: "stable",
      openAICodexFast: false,
      contextTokens: 300_000,
      contextWindow: 272_000,
    },
    controls: "enabled",
  },
];

export async function assertAstraVisualState(page, scenario) {
  const identity = page.locator(".footer-custom-build");
  assert.equal(await identity.count(), 1);
  assert.match((await identity.textContent()) ?? "", /^◆ Supah Coder Local Fork · [0-9a-f]{7}$/i);

  const meter = page.locator('.ctx-meter[role="meter"]');
  const calculatedPercent = Math.round(
    (scenario.state.contextTokens / scenario.state.contextWindow) * 100,
  );
  const windowLabel = scenario.state.contextWindow === 872_000 ? "872K" : "272K";
  const meterLabel = `Context used: ${scenario.state.contextTokens.toLocaleString("en-US")} / ${windowLabel} · ${calculatedPercent}%`;
  await meter.waitFor();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('.ctx-meter[role="meter"]')?.getAttribute("aria-label") === expected,
    meterLabel,
  );
  assert.equal(await meter.getAttribute("aria-label"), meterLabel);
  assert.equal(Number(await meter.getAttribute("aria-valuenow")), Math.min(100, calculatedPercent));

  const controls = page.locator(".astra-control-group");
  if (scenario.controls === "hidden") {
    await page.waitForFunction(() => !document.querySelector(".astra-control-group"));
    assert.equal(await controls.count(), 0);
    return;
  }
  await controls.waitFor();
  const contextSelector = controls.locator('select[aria-label="OpenAI Codex context profile"]');
  const fastSwitch = controls.locator('[role="switch"][aria-label="Fast · 2.5× credits"]');
  assert.equal(await contextSelector.inputValue(), scenario.state.openAICodexContextProfile);
  assert.equal(
    await fastSwitch.getAttribute("aria-checked"),
    String(scenario.state.openAICodexFast),
  );
  assert.equal(await contextSelector.isDisabled(), scenario.controls === "disabled");
  assert.equal(await fastSwitch.isDisabled(), scenario.controls === "disabled");
}

const authProviders = [
  ["anthropic", "Anthropic", "Claude models", true],
  ["openai", "OpenAI", "Codex + GPT models", true],
  ["gemini", "Google Gemini", "Gemini models", false],
  ["moonshot", "Moonshot", "Kimi models", false],
  ["glm", "Z.ai", "GLM models", false],
  ["minimax", "MiniMax", "MiniMax models", false],
  ["deepseek", "DeepSeek", "DeepSeek models", false],
  ["xai", "xAI", "Grok models", false],
].map(([value, label, description, connected]) => ({
  value,
  label,
  description,
  methods: ["oauth", "apikey"],
  connected,
}));

const models = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "anthropic" },
  { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "openai" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "gemini" },
  { id: "kimi-k3", name: "Kimi K3", provider: "moonshot" },
  {
    id: "local/ollama/qwen3-coder:30b",
    name: "qwen3-coder:30b",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: true,
    contextWindow: 262144,
    contextWindowKnown: true,
  },
].map((m) => ({ supportsThinking: true, contextWindow: 200000, ...m }));

const commands = [
  ["init", "Analyze the project and write a CLAUDE.md"],
  ["plan", "Enter read-only plan mode"],
  ["commit", "Stage, write a message, and commit"],
  ["review", "Review the working tree for bugs"],
  ["compact", "Compact the conversation to free context"],
  ["model", "Switch the active model"],
  ["add-dir", "Add another workspace root"],
  ["memory", "Show what the agent remembers"],
].map(([name, description]) => ({ name, aliases: [], description, source: "built-in" }));

const progress = {
  level: 14,
  rankName: "Shipwright",
  tier: 3,
  tierName: "Gold",
  tierGlyph: "◆",
  effectId: "gold",
  xp: 18240,
  xpIntoLevel: 740,
  xpForLevel: 1200,
  percent: 62,
  streak: { current: 9, best: 21 },
  totals: { prompts: 1284, commits: 337, linesShipped: 91240, projects: 7 },
  xpBySource: { prompts: 9820, commits: 6410, streakBonus: 2010 },
  memberSince: "2026-01-14T00:00:00.000Z",
  ladder: [],
  levelUp: null,
  eventNonce: null,
};

const usage = {
  provider: "anthropic",
  displayName: "Anthropic",
  connected: true,
  windows: [
    { kind: "current", label: "5-hour", usedPercent: 34, resetsAt: Date.now() + 96 * 60_000 },
    {
      kind: "weekly",
      label: "Weekly",
      usedPercent: 58,
      resetsAt: Date.now() + 3.5 * 24 * 60 * 60_000,
    },
  ],
  fetchedAt: Date.now(),
};

const localModel = (rawId, ctx, extra = {}) => ({
  id: `local/ollama/${rawId}`,
  rawId,
  contextWindow: ctx,
  contextWindowKnown: true,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
  ...extra,
});

const localModels = {
  endpoints: [
    {
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      kind: "ollama",
      custom: false,
      reachable: true,
      models: [
        localModel("qwen3-coder:30b", 262144, { supportsThinking: true }),
        localModel("deepseek-r1:14b", 131072, { supportsThinking: true }),
        localModel("llama3.2", 131072),
        localModel("embeddinggemma", 2048, { supportsTools: false }),
      ],
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      kind: "lmstudio",
      custom: false,
      reachable: false,
      reason: "LM Studio isn't running at http://127.0.0.1:1234/v1",
      models: [],
    },
  ],
};

// Command → canned response. Anything unlisted resolves to null (harmless).
export const responses = {
  sidecar_port: 45678,
  agent_state: state,
  agent_progress: progress,
  agent_usage: usage,
  app_auth_status: { providers: authProviders },
  app_settings_get: { projectsRoot: "/Users/demo/projects", configured: true },
  agent_serve_status: { running: false, configured: false },
  agent_models: { models },
  agent_commands: { commands },
  agent_tasks: { tasks: [] },
  agent_memories: { memories: [] },
  agent_jiwa: { jiwa: [] },
  agent_local: localModels,
  agent_local_scan: localModels,
  agent_radio_state: { playing: false, station: null },
  permissions_status: { screenRecording: true, accessibility: true, microphone: true },
  agent_projects: {
    projects: DEMO.projects.map((p, i) => ({
      ...p,
      lastActiveDisplay: ["2m ago", "1h ago", "yesterday", "3d ago"][i],
      sources: [["gg-coder"], ["gg-coder", "claude-code"], ["codex"], ["gg-coder"]][i],
    })),
  },
  agent_sessions: {
    sessions: DEMO.sessions.map((preview, i) => ({
      id: `demo-session-${i + 1}`,
      path: DEMO.cwd,
      preview,
      lastActiveDisplay: ["12m ago", "2h ago", "yesterday"][i],
      messageCount: [24, 61, 8][i],
    })),
  },
};

export function initScript(payload) {
  const { responses, appVersion } = payload;
  const paneId = "primary";
  const sessionId = responses.agent_state?.sessionId;
  const callbacks = new Map();
  // event name → set of callback ids registered through `plugin:event|listen`.
  const eventHandlers = new Map();
  let nextId = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
    convertFileSrc: (p) => p,
    transformCallback(cb) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    invoke(cmd, args) {
      if (cmd === "plugin:app|version") return Promise.resolve(appVersion);
      if (cmd === "plugin:event|listen") {
        const name = args?.event;
        const handler = args?.handler;
        if (typeof name === "string" && typeof handler === "number") {
          if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
          eventHandlers.get(name).add(handler);
        }
        return Promise.resolve(nextId++);
      }
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(null);
      if (cmd.startsWith("plugin:log|")) return Promise.resolve(null);
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) {
        return Promise.resolve(null);
      }
      if (cmd.startsWith("plugin:updater|")) return Promise.reject(new Error("no updates"));
      if (cmd === "agent_pane_status" && !(cmd in responses)) {
        return Promise.resolve({
          paneId: args?.paneId ?? paneId,
          generation: 1,
          ready: true,
          sessionId,
        });
      }
      return Promise.resolve(cmd in responses ? responses[cmd] : null);
    },
  };

  // Drive the transcript from the test: replays what the Rust shell would
  // forward from the sidecar's SSE stream.
  window.__ggEmit = (type, data) => {
    const ids = eventHandlers.get("agent-event");
    if (!ids) return 0;
    for (const id of ids) {
      callbacks.get(id)?.({
        event: "agent-event",
        id,
        payload: { paneId, sessionId, type, data: data ?? {} },
      });
    }
    return ids.size;
  };

  // Silence the media/webcam surfaces that have no place in a screenshot.
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
}

/**
 * Replay an entirely fictional run so the chat screenshot has substance.
 * Turn 1 completes; turn 2 is left mid-flight so the live tool panel, the
 * activity bar, and the streaming bubble are all on screen at once.
 */
async function playDemoConversation(page) {
  const emit = (type, data) => page.evaluate(([t, d]) => window.__ggEmit(t, d), [type, data ?? {}]);
  const say = async (text) => {
    await page.fill("textarea", text);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };
  const stream = async (chunks) => {
    for (const chunk of chunks) {
      await emit("text_delta", { text: chunk });
      await page.waitForTimeout(90);
    }
  };
  // A `null` result leaves that tool running (used for the final shot).
  const runTools = async (tools) => {
    for (const [id, name, args, result] of tools) {
      await emit("tool_call_start", { toolCallId: id, name, args });
      await page.waitForTimeout(160);
      if (result !== null) {
        await emit("tool_call_end", { toolCallId: id, result, isError: false });
        await page.waitForTimeout(90);
      }
    }
  };

  // ── Turn 1 (completes) ─────────────────────────────────────────────────────
  await say("Why does the checkout endpoint double-charge on a flaky connection?");
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  await runTools([
    ["t1", "grep", { pattern: "idempotenc", include: "*.ts" }, "no matches"],
    ["t2", "read", { file_path: "src/routes/checkout.ts" }, "read 184 lines"],
  ]);
  await stream([
    "`POST /api/checkout` calls the payment provider directly with no replay ",
    "protection, so the client's automatic retry lands as a second charge.\n\n",
    "The fix is an **idempotency key**: hash the cart + user, store the first ",
    "response for 24h, and return the cached result on a repeat.",
  ]);
  await emit("turn_end", {
    usage: { inputTokens: 18240, outputTokens: 640, cacheRead: 41200, cacheWrite: 2100 },
  });
  await emit("agent_done", {});
  await emit("run_end", {});
  await page.waitForTimeout(400);

  // ── Turn 2 (left running) ──────────────────────────────────────────────────
  await say("Do it, and add a regression test");
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  await runTools([
    ["t3", "write", { file_path: "src/lib/idempotency.ts" }, "wrote 62 lines"],
    ["t4", "edit", { file_path: "src/routes/checkout.ts" }, "1 edit applied"],
    ["t5", "edit", { file_path: "src/routes/checkout.test.ts" }, "1 edit applied"],
    ["t6", "bash", { command: "pnpm vitest run src/routes" }, null],
  ]);
  await stream([
    "Added `src/lib/idempotency.ts` and wired it into the checkout route — ",
    "replays now collapse onto the first charge. Running the suite",
  ]);
  await page.waitForTimeout(400);
}

/**
 * Autopilot: Ken silently reviews each finished turn and, when he isn't happy,
 * sends GG Coder back in for another pass. Replayed here as a full loop — build,
 * Ken bounces it, rebuild, Ken signs off — which is the whole point of the
 * feature and impossible to show in a static UI shot.
 */
async function playAutopilotLoop(page) {
  const emit = (type, data) => page.evaluate(([t, d]) => window.__ggEmit(t, d), [type, data ?? {}]);
  const stream = async (chunks) => {
    for (const chunk of chunks) {
      await emit("text_delta", { text: chunk });
      await page.waitForTimeout(80);
    }
  };
  const runTools = async (tools) => {
    for (const [id, name, args, result] of tools) {
      await emit("tool_call_start", { toolCallId: id, name, args });
      await page.waitForTimeout(140);
      await emit("tool_call_end", { toolCallId: id, result, isError: false });
      await page.waitForTimeout(80);
    }
  };
  const turn = async () => {
    await emit("turn_end", {
      usage: { inputTokens: 21400, outputTokens: 820, cacheRead: 44100, cacheWrite: 1800 },
    });
    await emit("agent_done", {});
    await emit("run_end", {});
    await page.waitForTimeout(300);
  };

  await page.fill("textarea", "Add rate limiting to the public API");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);

  // Round 1: GG Coder builds it.
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  await runTools([
    ["a1", "write", { file_path: "src/middleware/rate-limit.ts" }, "wrote 48 lines"],
    ["a2", "edit", { file_path: "src/app.ts" }, "1 edit applied"],
  ]);
  await stream([
    "Added a token-bucket limiter in `src/middleware/rate-limit.ts` and mounted ",
    "it on the public router. 100 req/min per IP.",
  ]);
  await turn();

  // Ken reviews it and isn't happy.
  await emit("autopilot_review_start", {});
  await page.waitForTimeout(900);
  await emit("autopilot_prompted", {
    body: "The bucket lives in module scope, so every worker process gets its own \ncounter and the real limit ends up 4x what you configured. Move it behind \nthe shared Redis client and add a test that proves two instances share state.",
  });
  await page.waitForTimeout(500);

  // Round 2: GG Coder fixes what Ken flagged.
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  await runTools([
    ["a3", "edit", { file_path: "src/middleware/rate-limit.ts" }, "1 edit applied"],
    ["a4", "write", { file_path: "src/middleware/rate-limit.test.ts" }, "wrote 41 lines"],
    ["a5", "bash", { command: "pnpm vitest run src/middleware" }, "6 passed (6)"],
  ]);
  await stream(["Good catch. Moved the bucket into Redis so it's shared across workers."]);
  await turn();

  // Ken signs off.
  await emit("autopilot_review_start", {});
  await page.waitForTimeout(800);
  await emit("autopilot_done", { copySeed: "clean" });
  await page.waitForTimeout(600);
}

/** Open a project and land in a fresh session. Shared by every in-app shot. */
const INTO_SESSION = [
  { click: "text=Code" },
  { click: ".picker-item" },
  { click: "text=+ New session" },
];

// Noteworthy screens only — the ones that actually sell the app. Not a tour.
const shots = [
  {
    name: "01-home",
    settle: 2200,
  },
  {
    name: "02-chat",
    viewport: { width: 1440, height: 800 },
    actions: INTO_SESSION,
    settle: 1200,
    play: playDemoConversation,
  },
  {
    name: "03-autopilot",
    viewport: { width: 1440, height: 620 },
    // The switch is a controlled input driven by the sidecar's state, so flip it
    // in the demo data rather than clicking a visually-hidden checkbox.
    responses: { agent_state: { ...state, autopilot: true } },
    actions: INTO_SESSION,
    settle: 1000,
    play: playAutopilotLoop,
  },
  {
    name: "04-projects",
    actions: [{ click: "text=Code" }],
    settle: 1400,
  },
  {
    name: "05-providers",
    viewport: { width: 1440, height: 1180 },
    actions: [{ click: "text=Login to AI Providers" }],
    settle: 900,
  },
  {
    name: "06-local-models",
    actions: [{ click: "text=Login to AI Providers" }, { click: "text=Local models" }],
    settle: 1200,
  },
  ...astraVisualScenarios.map((scenario, index) => ({
    name: `${String(index + 7).padStart(2, "0")}-${scenario.name}`,
    actions: INTO_SESSION,
    responses: {
      agent_state: scenario.state,
      agent_sessions: { sessions: [] },
      agent_pane_restore: 1,
      agent_pane_status: { paneId: "primary", generation: 1, ready: true },
    },
    settle: 700,
    verify: (page) => assertAstraVisualState(page, scenario),
  })),
  // NOTE: no model-picker shot. On macOS `ModelSelect` renders a native <select>
  // popup, which is an OS-level window Chromium cannot capture.
];

// ── The money shot ───────────────────────────────────────────────────────────
// Six windows, six projects, six models, all running at once. The app tiles any
// count, so the hero shouldn't imply a 4 cap. Each tile is captured as its own
// browser context (mirroring the real per-window sidecar isolation) and then
// composed into one image.
// Deliberately short: at README width each tile is only ~320px wide, so a tall
// window would render as mostly empty transcript with unreadable text.
const QUAD_VIEWPORT = { width: 1100, height: 560 };
const GRID_COLS = 3;

/** Per-window overrides: a different project, model and run in each one. */
const quadrants = [
  {
    id: "q1",
    cwd: "/Users/demo/projects/aurora-store",
    project: "aurora-store",
    branch: "checkout-retry",
    model: "claude-sonnet-4-6",
    modelLabel: "Claude Sonnet 4.6",
    provider: "anthropic",
    prompt: "Add a retry with idempotency keys to checkout",
    tools: [
      ["write", { file_path: "src/lib/idempotency.ts" }, "wrote 62 lines"],
      ["edit", { file_path: "src/routes/checkout.ts" }, "1 edit applied"],
      ["bash", { command: "pnpm vitest run src/routes" }, null],
    ],
    text: ["Wired the idempotency key through the checkout route. Running the tests"],
  },
  {
    id: "q2",
    cwd: "/Users/demo/projects/pixel-pipeline",
    project: "pixel-pipeline",
    branch: "sharp-migration",
    model: "gpt-5-codex",
    modelLabel: "GPT-5 Codex",
    provider: "openai",
    prompt: "Port the image resizer from jimp to sharp",
    tools: [
      ["grep", { pattern: "jimp", include: "*.ts" }, "9 matches in 4 files"],
      ["edit", { file_path: "src/resize.ts" }, "1 edit applied"],
      ["bash", { command: "pnpm bench resize" }, null],
    ],
    text: ["Swapped jimp for sharp in the resize path. Benchmarking both"],
  },
  {
    id: "q3",
    cwd: "/Users/demo/projects/rusty-parser",
    project: "rusty-parser",
    branch: "main",
    model: "local/ollama/qwen3-coder:30b",
    modelLabel: "qwen3-coder:30b",
    provider: "local",
    prompt: "Why does the tokenizer choke on nested comments?",
    tools: [
      ["read", { file_path: "src/lexer.rs" }, "read 240 lines"],
      ["bash", { command: "cargo test lexer" }, "1 failed, 18 passed"],
    ],
    text: [
      "`/* */` handling never tracks depth, so the first `*/` closes every ",
      "nesting level. Needs a counter instead of a boolean",
    ],
  },
  {
    id: "q4",
    cwd: "/Users/demo/projects/landing-page",
    project: "landing-page",
    branch: "pricing-table",
    model: "gemini-3-pro",
    modelLabel: "Gemini 3 Pro",
    provider: "gemini",
    prompt: "Make the pricing table work on mobile",
    tools: [
      ["read", { file_path: "src/components/Pricing.tsx" }, "read 118 lines"],
      ["edit", { file_path: "src/components/Pricing.tsx" }, "1 edit applied"],
      ["bash", { command: "pnpm playwright test pricing" }, null],
    ],
    text: ["Collapsed the table into stacked cards under 640px. Checking the snapshots"],
  },
  {
    id: "q5",
    cwd: "/Users/demo/projects/telemetry-api",
    project: "telemetry-api",
    branch: "batch-ingest",
    model: "kimi-k3",
    modelLabel: "Kimi K3",
    provider: "moonshot",
    prompt: "Batch the ingest writes, they're hammering the DB",
    tools: [
      ["grep", { pattern: "INSERT INTO events", include: "*.go" }, "4 matches in 2 files"],
      ["edit", { file_path: "internal/ingest/writer.go" }, "1 edit applied"],
      ["bash", { command: "go test ./internal/ingest" }, null],
    ],
    text: ["Buffering writes into 500-row batches with a 200ms flush. Running the tests"],
  },
  {
    id: "q6",
    cwd: "/Users/demo/projects/docs-site",
    project: "docs-site",
    branch: "search",
    model: "glm-4-6",
    modelLabel: "GLM-4.6",
    provider: "glm",
    prompt: "Add search to the docs sidebar",
    tools: [
      ["read", { file_path: "src/Sidebar.astro" }, "read 74 lines"],
      ["write", { file_path: "src/search.ts" }, "wrote 88 lines"],
      ["bash", { command: "pnpm build" }, null],
    ],
    text: ["Indexing headings at build time so search stays client-side. Building"],
  },
];

/** Drive one quadrant to a mid-run state so all four look alive at once. */
async function playQuadrant(page, quad) {
  const emit = (type, data) => page.evaluate(([t, d]) => window.__ggEmit(t, d), [type, data ?? {}]);
  await page.fill("textarea", quad.prompt);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await emit("run_start", {});
  await emit("thinking_delta", { text: "…" });
  for (const [index, [name, args, result]] of quad.tools.entries()) {
    const id = `${quad.id}-t${index}`;
    await emit("tool_call_start", { toolCallId: id, name, args });
    await page.waitForTimeout(130);
    // A null result leaves the last tool spinning, so the window reads as busy.
    if (result !== null) {
      await emit("tool_call_end", { toolCallId: id, result, isError: false });
      await page.waitForTimeout(80);
    }
  }
  for (const chunk of quad.text) {
    await emit("text_delta", { text: chunk });
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
}

/**
 * Compose the captured windows into a single grid image. The compositing
 * is done in the browser (an HTML page of four <img> tags, screenshotted) so the
 * script keeps its single dependency instead of pulling in an image library.
 */
async function captureWindowGrid(browser) {
  await mkdir(tileDir, { recursive: true });
  const tiles = [];
  for (const quad of quadrants) {
    const context = await browser.newContext({
      viewport: QUAD_VIEWPORT,
      deviceScaleFactor: 2,
    });
    // Each window gets its OWN project, model and git state, exactly what the
    // real per-window sidecars give you.
    const quadResponses = {
      ...responses,
      agent_state: {
        ...state,
        cwd: quad.cwd,
        provider: quad.provider,
        model: quad.model,
        gitBranch: quad.branch,
        kenProvider: quad.provider,
        kenModel: quad.model,
      },
      agent_models: {
        models: [
          ...models,
          { id: quad.model, name: quad.modelLabel, provider: quad.provider, contextWindow: 200000 },
        ],
      },
      agent_sessions: { sessions: [] },
      agent_projects: {
        projects: [
          { name: quad.project, path: quad.cwd, lastActiveDisplay: "now", sources: ["gg-coder"] },
        ],
      },
    };
    await context.addInitScript(initScript, { responses: quadResponses, appVersion: "0.29.0" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    for (const action of INTO_SESSION) {
      await page.click(action.click, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await playQuadrant(page, quad);
    const tile = resolve(tileDir, `${quad.id}.png`);
    await page.screenshot({ path: tile });
    tiles.push(tile);
    await context.close();
  }

  const gap = 14;
  const rows = Math.ceil(tiles.length / GRID_COLS);
  const composer = await browser.newContext({
    viewport: {
      width: QUAD_VIEWPORT.width * GRID_COLS + gap * (GRID_COLS + 1),
      height: QUAD_VIEWPORT.height * rows + gap * (rows + 1),
    },
    deviceScaleFactor: 1,
  });
  const page = await composer.newPage();
  // Inlined as data URLs: a `file://` <img> is blocked from the about:blank
  // origin `setContent` runs on, which silently yields broken images.
  const sources = await Promise.all(
    tiles.map(async (t) => `data:image/png;base64,${(await readFile(t)).toString("base64")}`),
  );
  await page.setContent(`<!doctype html>
<style>
  html, body { margin: 0; background: #0b0c0f; }
  .grid {
    display: grid;
    grid-template-columns: repeat(${GRID_COLS}, ${QUAD_VIEWPORT.width}px);
    gap: ${gap}px;
    padding: ${gap}px;
  }
  img {
    width: ${QUAD_VIEWPORT.width}px;
    height: ${QUAD_VIEWPORT.height}px;
    display: block;
    border-radius: 10px;
  }
</style>
<div class="grid">
  ${sources.map((src) => `<img src="${src}">`).join("\n  ")}
</div>`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
  const file = resolve(outDir, "00-many-windows.png");
  await page.screenshot({ path: file });
  await composer.close();
  await rm(tileDir, { recursive: true, force: true });
  console.log("✓ 00-many-windows");
  return file;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  // Headless Chromium creates no visible OS window; the native app is never launched.
  const browser = await chromium.launch({ headless: true });
  const results = [await captureWindowGrid(browser)];
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? viewport,
      deviceScaleFactor: 2,
    });
    await context.addInitScript(initScript, {
      responses: { ...responses, ...shot.responses },
      appVersion: "0.29.0",
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [console] ${m.text().slice(0, 160)}`);
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    for (const action of shot.actions ?? []) {
      try {
        await page.click(action.click, { timeout: 5000 });
      } catch {
        console.log(`  ! click failed: ${action.click}`);
      }
      await page.waitForTimeout(600);
    }
    if (shot.play) await shot.play(page);
    await page.waitForTimeout(shot.settle ?? 1000);
    if (shot.verify) await shot.verify(page);
    // Opening a modal from a tile scrolls its container; reset so the screen
    // behind the modal is framed from the top rather than mid-scroll.
    if (!shot.play) {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        for (const el of document.querySelectorAll("*")) {
          if (el.scrollTop > 0) el.scrollTop = 0;
        }
      });
      await page.waitForTimeout(250);
    }
    const file = resolve(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    results.push(file);
    console.log(`✓ ${shot.name}`);
    await context.close();
  }
  await browser.close();
  console.log(`\n${results.length} screenshot(s) → ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
