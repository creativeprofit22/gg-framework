import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StructuredToolResult } from "@kenkaiiii/gg-agent";
import type { DevTarget } from "../dev-app-driver/index.js";
import type { DevAppSpawnOptions } from "../dev-app-driver/launch.js";
import {
  appShellHtml,
  createFixturePage,
  DomControlClient,
  fieldValue,
  type FixturePage,
} from "../test-support/dev-app-dom.js";
import { FakeClock } from "../test-support/dev-app-driver-fakes.js";
import {
  createDevAppTool,
  DevAppManager,
  DevAppToolError,
  type DevAppToolDependencies,
} from "./dev-app.js";

const PORT = 9333;
const PID = 4242;
const TOKEN = "ggtok-fixture-7f3a9c2e1b5d";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dev-app-tool-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function appTarget(overrides: Partial<DevTarget> = {}): DevTarget {
  return {
    type: "page",
    url: "http://127.0.0.1:1420/",
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/APP`,
    ...overrides,
  };
}

interface HarnessOptions {
  html?: string;
  targets?: DevTarget[];
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  planMode?: boolean;
  fileExists?: (file: string) => boolean;
}

function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const page = createFixturePage(options.html ?? appShellHtml());
  const state = {
    targets: options.targets ?? [appTarget()],
    clients: [] as DomControlClient[],
    connected: [] as string[],
    spawned: [] as { args: readonly string[]; options: DevAppSpawnOptions }[],
    terminated: [] as number[],
    terminatedNow: [] as number[],
    removed: [] as string[],
    spawnError: null as ((options: DevAppSpawnOptions) => Error) | null,
    onClient: (_client: DomControlClient): void => {},
  };
  const root = path.join(dir, "profile-root");
  const manager = new DevAppManager();
  const planModeRef = { current: options.planMode ?? false };
  const deps: DevAppToolDependencies = {
    clock,
    fetch: async () => ({ ok: true, status: 200, json: async () => state.targets }),
    connect: async (url) => {
      state.connected.push(url);
      const client = new DomControlClient(page);
      state.onClient(client);
      state.clients.push(client);
      return client;
    },
    spawn: (_command, args, spawnOptions) => {
      if (state.spawnError) throw state.spawnError(spawnOptions);
      state.spawned.push({ args, options: spawnOptions });
      return { pid: PID, exitCode: null, once: () => undefined };
    },
    terminate: async (pid) => {
      state.terminated.push(pid);
    },
    terminateNow: (pid) => {
      state.terminatedNow.push(pid);
    },
    platform: options.platform ?? "win32",
    env: options.env ?? {},
    reservePort: async () => PORT,
    createProfileRoot: async () => root,
    removeProfileRoot: async (removed) => {
      state.removed.push(removed);
    },
    fileExists: options.fileExists ?? (() => true),
    shrinkImage: async (buffer, mediaType) => ({ buffer, mediaType }),
    previewImage: async (buffer) => buffer,
    now: () => new Date("2026-11-01T00:00:00.000Z"),
  };
  const tool = createDevAppTool(dir, manager, planModeRef, deps);
  const execute = (args: Record<string, unknown>, signal = new AbortController().signal) =>
    Promise.resolve(tool.execute(args as never, { signal, toolCallId: "t" }));
  const call = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    const result = await clock.settle(execute(args, signal));
    if (typeof result !== "string") throw new Error("expected a text result");
    return result;
  };
  const client = (): DomControlClient => {
    const last = state.clients.at(-1);
    if (!last) throw new Error("no client connected");
    return last;
  };
  return { clock, page, state, root, manager, planModeRef, tool, execute, call, client };
}

async function failure(promise: Promise<unknown>): Promise<DevAppToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DevAppToolError) return error;
    throw error;
  }
  throw new Error("expected a DevAppToolError");
}

function refFor(snapshot: string, name: string): string {
  const match = new RegExp(`^(e\\d+) \\S+ "${name}"`, "m").exec(snapshot);
  if (!match?.[1]) throw new Error(`no ref for ${name} in:\n${snapshot}`);
  return match[1];
}

function addTo(page: FixturePage, selector: string, html: string): void {
  page.find(selector).insertAdjacentHTML("beforeend", html);
}

const DIALOG = `<div class="dlg" role="dialog" aria-modal="true" data-z="10" data-rect="100,100,400,300"><button data-rect="120,120,80,20">Close</button></div>`;
const MENU = `<div class="slash-menu" data-rect="10,600,300,80"><div role="option" data-rect="10,600,300,20">/help</div></div>`;

describe("dev_app open attach", () => {
  it("attaches to the app page over loopback and returns a first snapshot", async () => {
    const h = harness();
    const out = await h.call({ action: "open", mode: "attach", port: PORT });
    expect(out).toContain(`Attached to the dev app on port ${PORT} (http://127.0.0.1:1420/)`);
    expect(out).toContain("close leaves it running");
    expect(out).toMatch(/Snapshot 1 · pane pane-a: draft "", menu closed, status Ready/);
    expect(out).toMatch(/textbox "Message"/);
    expect(h.state.connected).toEqual([`ws://127.0.0.1:${PORT}/devtools/page/APP`]);
    expect(out).not.toContain("ws://");
  });

  it("refuses to attach without a port the user gave", async () => {
    const h = harness();
    const error = await failure(h.call({ action: "open", mode: "attach" }));
    expect(error.code).toBe("endpoint_refused");
    expect(error.message).toMatch(/Next: ask the user which port/);
    expect(h.state.connected).toEqual([]);
  });

  it("refuses targets that are not the dev app page, within the deadline", async () => {
    const h = harness({ targets: [appTarget({ url: "http://127.0.0.1:3000/" })] });
    const error = await failure(
      h.call({ action: "open", mode: "attach", port: PORT, deadline_ms: 2000 }),
    );
    expect(error.code).toBe("endpoint_refused");
    expect(h.clock.time).toBeLessThanOrEqual(2000);
    expect(h.state.connected).toEqual([]);
  });

  it("refuses a debugger address off loopback or on another port", async () => {
    for (const url of [
      `ws://10.0.0.5:${PORT}/devtools/page/APP`,
      "ws://127.0.0.1:9999/devtools/page/APP",
    ]) {
      const h = harness({ targets: [appTarget({ webSocketDebuggerUrl: url })] });
      const error = await failure(h.call({ action: "open", mode: "attach", port: PORT }));
      expect(error.code).toBe("endpoint_refused");
      expect(error.message).not.toContain("ws://");
      expect(h.state.connected).toEqual([]);
    }
  });

  it("refuses to guess between two app pages", async () => {
    const h = harness({
      targets: [appTarget(), appTarget({ url: "http://localhost:1420/?pane=2" })],
    });
    const error = await failure(h.call({ action: "open", mode: "attach", port: PORT }));
    expect(error.code).toBe("ambiguous_target");
    expect(error.message).toMatch(/Next: close the extra dev app windows/);
  });
});

describe("dev_app open launch", () => {
  it("launches with an isolated profile, owns the app and stops it on close", async () => {
    const appDir = path.join(dir, "gg-app");
    const h = harness({ fileExists: (file) => file.startsWith(appDir) });
    const out = await h.call({ action: "open", mode: "launch" });
    expect(out).toContain(`Launched the dev app with an isolated profile (control port ${PORT})`);
    expect(out).toMatch(/Snapshot 1 · pane pane-a/);
    const [spawned] = h.state.spawned;
    expect(spawned?.args.slice(1)).toEqual([
      "dev",
      "--no-watch",
      "--config",
      path.join(appDir, "src-tauri", "tauri.local.conf.json"),
    ]);
    expect(spawned?.options.cwd).toBe(appDir);
    expect(spawned?.options.env.GG_PHASE25_DEV_FIXTURE_CDP_PORT).toBe(String(PORT));
    expect(spawned?.options.env.WEBVIEW2_USER_DATA_FOLDER?.startsWith(h.root)).toBe(true);
    expect(out).not.toContain(h.root);

    expect(await h.call({ action: "close" })).toBe(
      "Closed the connection and stopped the dev app this session launched.",
    );
    expect(h.state.terminated).toEqual([PID]);
    expect(h.state.removed).toEqual([h.root]);
    expect(h.manager.current).toBeUndefined();
  });

  it("keeps the user's Rust toolchain reachable from the isolated profile", async () => {
    const home = path.join(dir, "user-home");
    const h = harness({ env: { USERPROFILE: home, RUSTUP_HOME: path.join(dir, "rustup") } });
    await h.call({ action: "open", mode: "launch" });
    const env = h.state.spawned[0]?.options.env;
    expect(env?.USERPROFILE?.startsWith(h.root)).toBe(true);
    expect(env?.CARGO_HOME).toBe(path.join(home, ".cargo"));
    expect(env?.RUSTUP_HOME).toBe(path.join(dir, "rustup"));
  });

  it("waits for the new window to render before the first snapshot, within the deadline", async () => {
    const h = harness({ html: "" });
    h.clock.at(4000, () => addTo(h.page, "body", appShellHtml()));
    const out = await h.call({ action: "open", mode: "launch" });
    expect(out).toMatch(/textbox "Message"/);
    expect(h.clock.time).toBeLessThan(10_000);

    const blank = harness({ html: "" });
    const empty = await blank.call({ action: "open", mode: "launch", deadline_ms: 2000 });
    expect(empty).toContain("No visible interactive elements");
    expect(blank.clock.time).toBeLessThanOrEqual(2000);
  });

  it("opens a Code agent pane when the fresh workspace is empty", async () => {
    const h = harness({
      html: `<div data-pane-id="primary" data-rect="0,0,640,800"><button data-rect="10,10,80,20">Settings</button></div>`,
    });
    const store = new Map<string, string>([
      [
        "gg-workspace-layout-recursive:main",
        JSON.stringify({ version: 9, focusedPaneId: "primary", panes: { primary: null } }),
      ],
    ]);
    const win = h.page.window as unknown as Record<string, unknown>;
    win.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    };
    win.setTimeout = (run: () => void) => h.clock.at(h.clock.time + 300, run);
    win.location = {
      reload: () => {
        h.page.document.body.innerHTML = appShellHtml();
      },
    };
    const out = await h.call({ action: "open", mode: "launch" });
    const layout = JSON.parse(store.get("gg-workspace-layout-recursive:main") ?? "{}");
    expect(layout.panes.primary).toEqual({
      kind: "agent",
      mode: "code",
      cwd: path.join(h.root, "project"),
      sessionPath: null,
    });
    expect(out).toContain("a Code agent pane was opened on an empty scratch project");
    expect(out).toMatch(/Snapshot 1 · pane pane-a: draft ""/);
    expect(out).not.toContain(h.root);
  });

  it("waits for the pane's session to load before the first snapshot", async () => {
    const h = harness();
    const skeleton = h.page.document.createElement("div");
    skeleton.className = "transcript-skeleton";
    h.page.find(".agent-pane").append(skeleton);
    h.clock.at(1500, () => skeleton.remove());
    const out = await h.call({ action: "open", mode: "launch" });
    expect(h.clock.time).toBeGreaterThanOrEqual(1500);
    expect(out).toMatch(/Snapshot 1 · pane pane-a/);
    expect(out).not.toContain("agent pane was opened");
  });

  it("is Windows only", async () => {
    const h = harness({ platform: "linux" });
    const error = await failure(h.call({ action: "open", mode: "launch" }));
    expect(error.code).toBe("unsupported_platform");
    expect(error.message).toMatch(/Next: start the dev app yourself/);
    expect(h.state.spawned).toEqual([]);
  });

  it("reports launch_failed without the app folder and hides profile paths", async () => {
    const missing = harness({ fileExists: () => false });
    expect((await failure(missing.call({ action: "open", mode: "launch" }))).code).toBe(
      "launch_failed",
    );

    const h = harness();
    h.state.spawnError = (options) =>
      new Error(`cannot start in ${options.env.WEBVIEW2_USER_DATA_FOLDER}`);
    const error = await failure(h.call({ action: "open", mode: "launch" }));
    expect(error.code).toBe("launch_failed");
    expect(error.message).toContain("[profile]");
    expect(error.message).not.toContain(h.root);
    expect(h.state.removed).toEqual([h.root]);
  });

  it("stops the owned tree when the call is aborted while waiting", async () => {
    const h = harness({ targets: [] });
    const controller = new AbortController();
    h.clock.at(1000, () => controller.abort());
    const error = await failure(h.call({ action: "open", mode: "launch" }, controller.signal));
    expect(error.code).toBe("aborted");
    expect(h.state.terminated).toEqual([PID]);
    expect(h.state.removed).toEqual([h.root]);
    expect(h.manager.current).toBeUndefined();
  });

  it("replaces an attached connection without stopping that app", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    const attached = h.client();
    await h.call({ action: "open", mode: "launch" });
    expect(attached.closed).toBe(true);
    expect(h.state.terminated).toEqual([]);
    expect(h.manager.current?.session.owned).toBe(true);
  });

  it("reconnecting to the launched app keeps the right to stop it", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "launch" });
    h.client().gone();
    const out = await h.call({ action: "open", mode: "attach" });
    expect(out).toContain(`Reconnected to the dev app this session launched (port ${PORT})`);
    await h.manager.shutdown();
    expect(h.state.terminated).toEqual([PID]);
  });

  it("shutdownNow kills an owned launched app synchronously", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "launch" });
    const client = h.client();
    h.manager.shutdownNow();
    expect(h.state.terminatedNow).toEqual([PID]);
    expect(h.state.terminated).toEqual([]);
    expect(client.closed).toBe(true);
    expect(h.manager.current).toBeUndefined();
  });

  it("shutdownNow kills the launched app after a reconnect", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "launch" });
    h.client().gone();
    await h.call({ action: "open", mode: "attach" });
    const reconnected = h.client();
    h.manager.shutdownNow();
    expect(reconnected.closed).toBe(true);
    expect(h.state.terminatedNow).toEqual([PID]);
  });

  it("shutdownNow only closes an attached app", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    const client = h.client();
    h.manager.shutdownNow();
    expect(client.closed).toBe(true);
    expect(h.state.terminatedNow).toEqual([]);
    expect(h.state.terminated).toEqual([]);
    expect(h.manager.current).toBeUndefined();
  });
});

describe("dev_app snapshot", () => {
  it("needs an open connection", async () => {
    const h = harness();
    const error = await failure(h.call({ action: "snapshot" }));
    expect(error.code).toBe("not_attached");
    expect(error.message).toMatch(/^\[not_attached\] .+\. Next: call dev_app open/);
  });

  it("reports a gone page and an unknown pane", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    expect((await failure(h.call({ action: "snapshot", pane: "nope" }))).code).toBe(
      "pane_not_found",
    );
    h.client().gone();
    expect((await failure(h.call({ action: "snapshot" }))).code).toBe("target_gone");
  });

  it("adds a screenshot saved under .gg/screenshots", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    const result = (await h.execute({
      action: "snapshot",
      screenshot: true,
    })) as StructuredToolResult;
    const saved = path.join(dir, ".gg", "screenshots", "dev-app-2026-11-01T00-00-00-000Z.png");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.content[0])).toContain("Snapshot 2");
    expect(result.content[1]).toEqual({
      type: "image",
      mediaType: "image/png",
      data: h.client().screenshot,
    });
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved).toString()).toBe("fake-png");
    expect(h.client().inputs("Page.captureScreenshot")).toHaveLength(1);
  });

  it("stays bounded on a crowded page", async () => {
    const buttons = Array.from(
      { length: 300 },
      (_, index) => `<button data-rect="10,${index * 2},50,2">Button number ${index}</button>`,
    ).join("");
    const h = harness({ html: appShellHtml({ pane: buttons }) });
    const out = await h.call({ action: "open", mode: "attach", port: PORT });
    expect(out).toMatch(/more not shown/);
    expect(out.length).toBeLessThan(9000);
  });

  it("times out on a stuck page without passing the deadline", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    h.client().beforeEvaluate = () => new Promise<void>(() => {});
    const start = h.clock.time;
    const error = await failure(h.call({ action: "snapshot", deadline_ms: 60_000 }));
    expect(error.code).toBe("timed_out");
    expect(h.clock.time - start).toBeLessThanOrEqual(30_000);
  });
});

describe("dev_app act", () => {
  async function attached(html = appShellHtml()) {
    const h = harness({ html });
    const first = await h.call({ action: "open", mode: "attach", port: PORT });
    return { ...h, first };
  }

  it("types into the composer by ref and confirms the draft", async () => {
    const h = await attached();
    const out = await h.call({
      action: "act",
      kind: "type",
      text: "hi",
      ref: refFor(h.first, "Message"),
    });
    expect(out).toMatch(/^confirmed: /);
    expect(out).toContain('draft "" → "hi"');
    expect(out).toMatch(/elapsed \d+ ms$/);
    expect(fieldValue(h.page.find("textarea.input"))).toBe("hi");
  });

  it("types into the focused field and confirms it grew", async () => {
    const h = await attached(
      appShellHtml({ pane: `<input class="name" aria-label="Name" data-rect="10,40,200,20">` }),
    );
    h.page.focus(h.page.find(".name"));
    const out = await h.call({ action: "act", kind: "type", text: "demo" });
    expect(out).toMatch(/^confirmed: .*the focused field gains "demo"/);
    expect(fieldValue(h.page.find(".name"))).toBe("demo");
  });

  it("contradicts typing when no text field has focus", async () => {
    const h = await attached();
    const error = await failure(h.call({ action: "act", kind: "type", text: "x" }));
    expect(error.code).toBe("contradicted");
    expect(error.message).toMatch(/no text field is focused/);
  });

  it("presses a key combination and reports what appeared", async () => {
    const h = await attached();
    h.client().onKey = (key, modifiers) => {
      if (key === "k" && modifiers === 2) addTo(h.page, "body", DIALOG);
    };
    const out = await h.call({ action: "act", kind: "press", key: "k", modifiers: ["ctrl"] });
    expect(out).toMatch(/^confirmed: /);
    expect(out).toContain("dialog closed → open");
    expect(out).toMatch(/\+ button "Close"/);
    const keyDown = h.client().inputs("Input.dispatchKeyEvent")[0];
    expect(keyDown?.params).toMatchObject({ key: "k", modifiers: 2 });
  });

  it("infers that Escape closes an open menu", async () => {
    const h = await attached(appShellHtml({ pane: MENU }));
    h.client().onKey = (key) => {
      if (key === "Escape") h.page.find(".slash-menu").remove();
    };
    const out = await h.call({ action: "act", kind: "press", key: "Escape" });
    expect(out).toMatch(/^confirmed: .*the menu closed/);
    expect(out).toContain("menu open → closed");
  });

  it("checks an explicit expectation", async () => {
    const h = await attached(appShellHtml({ extra: DIALOG }));
    h.client().onKey = (key) => {
      if (key === "Escape") h.page.find(".dlg").remove();
    };
    const out = await h.call({
      action: "act",
      kind: "press",
      key: "Escape",
      expect: { kind: "dialog_closed" },
    });
    expect(out).toMatch(/^confirmed: .*no dialog is open/);
  });

  it("clicks by ref and lists added elements, capped", async () => {
    const h = await attached(
      appShellHtml({ pane: `<button class="more" data-rect="10,10,80,20">More</button>` }),
    );
    h.client().onClick = (element) => {
      if (!element.matches(".more")) return;
      const extra = Array.from(
        { length: 20 },
        (_, index) => `<button data-rect="100,${40 + index * 22},80,20">Item ${index}</button>`,
      ).join("");
      addTo(h.page, ".agent-pane", extra);
    };
    const out = await h.call({ action: "act", kind: "click", ref: refFor(h.first, "More") });
    expect(out).toMatch(/^confirmed: click e\d+ — the page changed/);
    expect(out).toMatch(/\+ button "Item 0"/);
    expect(out).toMatch(/\d+ more changes not shown/);
  });

  it.each([
    ["Off", `<button disabled data-rect="10,10,80,20">Off</button>`, "element_disabled"],
    [
      "Under",
      `<button data-rect="300,10,80,20">Under</button><div data-z="5" data-rect="290,0,120,40"></div>`,
      "element_covered",
    ],
    ["Far", `<button data-rect="2000,10,50,20">Far</button>`, "element_offscreen"],
  ])("refuses to click %s with %s", async (name, pane, code) => {
    const h = await attached(appShellHtml({ pane }));
    const error = await failure(
      h.call({ action: "act", kind: "click", ref: refFor(h.first, name) }),
    );
    expect(error.code).toBe(code);
    expect(h.client().inputs("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("refuses refs that are gone or never existed", async () => {
    const h = await attached(
      appShellHtml({ pane: `<button class="go" data-rect="10,10,80,20">Go</button>` }),
    );
    const ref = refFor(h.first, "Go");
    h.page.find(".go").remove();
    const gone = await failure(h.call({ action: "act", kind: "click", ref }));
    expect(gone.code).toBe("stale_ref");
    expect(gone.message).toMatch(/Next: take a new snapshot/);
    expect((await failure(h.call({ action: "act", kind: "click", ref: "e999" }))).code).toBe(
      "stale_ref",
    );
  });

  it.each([[{ kind: "press", key: "Enter" }], [{ kind: "send_prompt", text: "hello" }]])(
    "refuses ref with %o instead of dropping it",
    async (args) => {
      const h = await attached(
        appShellHtml({ pane: `<button class="go" data-rect="10,10,80,20">Go</button>` }),
      );
      const error = await failure(h.call({ action: "act", ...args, ref: refFor(h.first, "Go") }));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toMatch(/does not take ref/);
      expect(error.message).toMatch(/Next: fix the arguments and call again/);
      expect(h.client().inputs("Input.dispatchKeyEvent")).toHaveLength(0);
      expect(h.client().inputs("Input.insertText")).toEqual([]);
    },
  );

  it("sends a prompt and confirms it started", async () => {
    const h = await attached();
    h.client().onKey = (key) => {
      if (key !== "Enter") return;
      h.page.find("textarea.input").textContent = "";
      h.page.find(".statusrow-state").textContent = "Working";
    };
    const out = await h.call({ action: "act", kind: "send_prompt", text: "hello" });
    expect(out).toMatch(/^confirmed: send prompt/);
    expect(out).toContain("status Ready → Working");
  });

  it("says an open dialog covers the composer when send_prompt cannot reach it", async () => {
    const h = await attached(appShellHtml({ extra: DIALOG }));
    h.page.focus(h.page.find(".dlg button"));
    // Like the real app, the dialog keeps focus, so the composer cannot take it.
    Object.defineProperty(h.page.find("textarea.input"), "focus", { value: () => {} });
    const error = await failure(h.call({ action: "act", kind: "send_prompt", text: "hello" }));
    expect(error.code).toBe("element_covered");
    expect(error.message).toMatch(/dialog open/);
    expect(error.message).toMatch(/Next: close what covers it \(Escape closes menus and dialogs\)/);
    expect(h.client().inputs("Input.insertText")).toEqual([]);
  });

  it("names a menu that swallowed the prompt", async () => {
    const h = await attached(appShellHtml({ pane: MENU }));
    const error = await failure(h.call({ action: "act", kind: "send_prompt", text: "hello" }));
    expect(error.code).toBe("menu_swallowed_key");
    expect(error.message).toMatch(
      /Next: press Escape to close the menu, then press Enter with expect status_is "Working"\./,
    );
    expect(h.client().inputs("Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("contradicts a prompt sent while the pane is already working", async () => {
    const h = await attached(appShellHtml({ status: "Working" }));
    const error = await failure(h.call({ action: "act", kind: "send_prompt", text: "hello" }));
    expect(error.code).toBe("contradicted");
    expect(error.message).toMatch(/already Working/);
  });

  it("times out when nothing changes, inside the capped deadline", async () => {
    const h = await attached();
    const start = h.clock.time;
    const error = await failure(
      h.call({ action: "act", kind: "press", key: "Tab", deadline_ms: 60_000 }),
    );
    expect(error.code).toBe("timed_out");
    expect(error.message).toMatch(/nothing changed/);
    expect(h.clock.time - start).toBeLessThanOrEqual(30_000);
  });

  it("times out on a stuck page before acting", async () => {
    const h = await attached();
    h.client().beforeEvaluate = () => new Promise<void>(() => {});
    const start = h.clock.time;
    const error = await failure(
      h.call({ action: "act", kind: "press", key: "Tab", deadline_ms: 1000 }),
    );
    expect(error.code).toBe("timed_out");
    expect(h.clock.time - start).toBeLessThanOrEqual(1000);
    expect(h.client().inputs("Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("reports an unreadable expectation", async () => {
    const h = await attached();
    const error = await failure(
      h.call({
        action: "act",
        kind: "press",
        key: "Tab",
        expect: { kind: "element_appears", value: "[[[" },
      }),
    );
    expect(error.code).toBe("page_unreadable");
  });

  it.each([
    [{ kind: "click" }, /click needs ref/],
    [{ kind: "click", ref: "x7" }, /not a ref like e7/],
    [{ kind: "type", text: "  " }, /type needs non-empty text/],
    [{ kind: "press" }, /press needs key/],
    [{ kind: "press", key: "NotAKey" }, /NotAKey/],
    [{ kind: "press", key: "Tab", expect: { kind: "text_appears" } }, /needs a value/],
    [
      { kind: "press", key: "Tab", expect: { kind: "element_appears", value: "e1" } },
      /CSS selector, not a ref/,
    ],
  ])("rejects bad input %o", async (args, pattern) => {
    const h = await attached();
    const error = await failure(h.call({ action: "act", ...args }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(pattern);
    expect(h.client().sent).toEqual([]);
  });
});

describe("dev_app plan mode", () => {
  it("refuses act and launch but allows attach, snapshot and close", async () => {
    const h = harness({ planMode: true });
    expect(await h.call({ action: "open", mode: "launch" })).toMatch(
      /dev_app launch is restricted in plan mode/,
    );
    expect(h.state.spawned).toEqual([]);
    expect(await h.call({ action: "open", mode: "attach", port: PORT })).toContain("Attached");
    expect(await h.call({ action: "act", kind: "press", key: "Tab" })).toMatch(
      /dev_app act is restricted in plan mode/,
    );
    expect(h.client().sent).toEqual([]);
    expect(await h.call({ action: "snapshot" })).toMatch(/^Snapshot 2/);
    expect(await h.call({ action: "close" })).toMatch(/keeps running/);
  });
});

describe("dev_app close and secrets", () => {
  it("leaves an attached app running", async () => {
    const h = harness();
    expect(await h.call({ action: "close" })).toBe("No dev app connection is open.");
    await h.call({ action: "open", mode: "attach", port: PORT });
    expect(await h.call({ action: "close" })).toBe(
      "Closed the connection. The dev app keeps running (this session did not start it).",
    );
    expect(h.client().closed).toBe(true);
    expect(h.state.terminated).toEqual([]);
  });

  it("never shows an environment secret or token, even when the page holds it", async () => {
    const h = harness({
      env: { GG_DAEMON_TOKEN: TOKEN },
      html: appShellHtml({
        pane: `<button data-rect="10,10,200,20">${TOKEN}</button>`,
        status: `Ready ${TOKEN}`,
      }),
    });
    const outputs = [await h.call({ action: "open", mode: "attach", port: PORT })];
    h.client().onKey = () => {
      h.page.find(".statusrow-state").textContent = `Saved ${TOKEN}`;
    };
    outputs.push(await h.call({ action: "act", kind: "press", key: "Tab" }));
    outputs.push(
      (await failure(h.call({ action: "act", kind: "type", text: "x", deadline_ms: 200 }))).message,
    );
    for (const output of outputs) {
      expect(output).not.toContain(TOKEN);
    }
    expect(outputs.join("\n")).toContain("[REDACTED]");
  });
});

describe("dev_app snapshot expect", () => {
  it("waits for text to appear, then returns the verdict and a snapshot", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    const start = h.clock.time;
    h.clock.at(start + 2000, () => addTo(h.page, ".agent-pane", `<p>REPLY-DONE</p>`));
    const out = await h.call({
      action: "snapshot",
      expect: { kind: "text_appears", value: "REPLY-DONE" },
      deadline_ms: 10_000,
    });
    expect(out).toMatch(/^confirmed: wait for text "REPLY-DONE" appears/);
    expect(out).toMatch(/Snapshot 2 · pane pane-a/);
    expect(h.clock.time - start).toBeGreaterThanOrEqual(2000);
    expect(h.clock.time - start).toBeLessThan(10_000);
    expect(h.client().sent).toEqual([]);
  });

  it("times out inside the deadline when the text never appears", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    const start = h.clock.time;
    const error = await failure(
      h.call({
        action: "snapshot",
        expect: { kind: "text_appears", value: "NEVER" },
        deadline_ms: 60_000,
      }),
    );
    expect(error.code).toBe("timed_out");
    expect(error.message).toMatch(/saw .*status Ready/);
    expect(h.clock.time - start).toBeLessThanOrEqual(30_000);
    expect(h.client().sent).toEqual([]);
  });

  it("is allowed in plan mode because it never acts", async () => {
    const h = harness({ planMode: true });
    await h.call({ action: "open", mode: "attach", port: PORT });
    const out = await h.call({ action: "snapshot", expect: { kind: "status_is", value: "Ready" } });
    expect(out).toMatch(/^confirmed: .*pane status is "Ready"/);
    expect(h.client().sent).toEqual([]);
  });
});

describe("dev_app slash command replay (simulated page)", () => {
  it("catches a send swallowed by the slash menu, recovers, and reads the result", async () => {
    const h = harness();
    await h.call({ action: "open", mode: "attach", port: PORT });
    const client = h.client();
    let dismissed = false;
    // Like the app: a draft starting with "/" opens the slash menu until Escape closes it.
    client.beforeEvaluate = () => {
      const draft = fieldValue(h.page.find("textarea.input"));
      const open = h.page.document.querySelector(".slash-menu") !== null;
      if (draft.startsWith("/") && !dismissed && !open) addTo(h.page, ".agent-pane", MENU);
    };
    client.onKey = (key) => {
      const menu = h.page.document.querySelector(".slash-menu");
      if (key === "Escape" && menu) {
        menu.remove();
        dismissed = true;
      } else if (key === "Enter" && !menu) {
        h.page.find("textarea.input").textContent = "";
        h.page.find(".statusrow-state").textContent = "Working";
        h.clock.at(h.clock.time + 3000, () =>
          addTo(h.page, ".agent-pane", `<p>STEROIDS-REPLAY-RESULT</p>`),
        );
      }
    };

    const start = h.clock.time;
    const swallowed = await failure(
      h.call({ action: "act", kind: "send_prompt", text: "/steroids" }),
    );
    expect(swallowed.code).toBe("menu_swallowed_key");
    expect(h.clock.time - start).toBeLessThan(5000);
    expect(client.inputs("Input.dispatchKeyEvent")).toHaveLength(0);

    expect(await h.call({ action: "act", kind: "press", key: "Escape" })).toMatch(
      /^confirmed: .*the menu closed/,
    );
    const sent = await h.call({
      action: "act",
      kind: "press",
      key: "Enter",
      expect: { kind: "status_is", value: "Working" },
    });
    expect(sent).toMatch(/^confirmed: press Enter — pane status is "Working"/);
    const result = await h.call({
      action: "snapshot",
      expect: { kind: "text_appears", value: "STEROIDS-REPLAY-RESULT" },
      deadline_ms: 10_000,
    });
    expect(result).toMatch(/^confirmed: /);
    expect(h.clock.time - start).toBeLessThan(15_000);
  });
});
