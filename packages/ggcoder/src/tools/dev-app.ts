import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentTool, StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { environmentSecrets, redactText } from "@kenkaiiii/gg-ai";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import {
  AmbiguousTargetError,
  attachDevApp,
  captureScreenshot,
  condition,
  configureFakeProvider,
  createDevAppDriver,
  createIsolatedProfile,
  describeElement,
  describePageState,
  DevAppActionError,
  DevCdpClient,
  devAppEnvironment,
  draftEquals,
  elementAppears,
  elementGone,
  focusOn,
  formatSnapshot,
  isAppWindowTarget,
  isRef,
  launchDevApp,
  listTargets,
  observeScript,
  pageChanged,
  parsePageState,
  parseSnapshot,
  refLocatorScript,
  resolveKey,
  seedAgentPaneScript,
  snapshotScript,
  startFakeProvider,
  systemClock,
  textAppears,
  textGone,
  type ActionOutcome,
  type ControlClient,
  type DevAppSession,
  type DevTarget,
  type DriverClock,
  type Expectation,
  type FakeProvider,
  type FetchLike,
  type IsolatedProfile,
  type Observation,
  type PageState,
  type PaneSelector,
  type SpawnDevApp,
} from "../dev-app-driver/index.js";
import { downscaleForPreview, shrinkToFit } from "../utils/image.js";
import { killProcessTree } from "../utils/process.js";

const ACT_DEFAULT_MS = 5_000;
const ACT_MAX_MS = 30_000;
// One launch call waits this long; the app keeps starting in the background after it returns.
const LAUNCH_DEFAULT_MS = 120_000;
const LAUNCH_MAX_MS = 240_000;
// A cold Rust build plus the daemon's first start took about 8 minutes on 2026-11-02.
const LAUNCH_READY_MS = 1_200_000;
// Part of a launch call kept for rendering, opening a pane and the first snapshot.
const LAUNCH_FINISH_RESERVE_MS = 30_000;
const LAUNCH_LOG_TAIL_CHARS = 4_000;
// A wheel step either scrolls at once or never does, so a short default keeps "already at the end" quick.
const SCROLL_DEFAULT_MS = 1_500;
const WHEEL_STEP_PX = 600;
const LOCAL_FORK_IDENTITY = "com.ggcoder.local-fork";
// The replay smoke's daemon wrapper: the real daemon with only Azure traffic sent to a loopback URL.
const FAKE_PROVIDER_SIDECAR = path.join("scripts", "dev-app-replay-dev-smoke.mjs");
// Below the default call deadline, so one stuck request never outlives the call that sent it.
const REQUEST_TIMEOUT_MS = 4_500;
const MAX_CHANGE_LINES = 12;
const RENDER_WAIT_MS = 30_000;
// The transcript skeleton shows until the pane's session has loaded.
const PANE_LOADING_SCRIPT = `Boolean(document.querySelector('.agent-pane .transcript-skeleton'))`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const EXPECT_KINDS = [
  "text_appears",
  "text_gone",
  "element_appears",
  "element_gone",
  "draft_equals",
  "focus_on",
  "menu_open",
  "menu_closed",
  "dialog_open",
  "dialog_closed",
  "status_is",
] as const;

const ExpectSpec = z.object({
  kind: z.enum(EXPECT_KINDS).describe("What must become true after acting"),
  value: z
    .string()
    .optional()
    .describe(
      "text_*: text; element_*: CSS selector (element_gone also takes a ref); draft_equals: draft; focus_on: selector or ref; status_is: status",
    ),
});

const DevAppParams = z.object({
  action: z.enum(["open", "snapshot", "act", "window", "close"]).describe("What to do"),
  mode: z
    .enum(["attach", "launch"])
    .optional()
    .describe("open: attach to a running dev app, or launch one (Windows only)"),
  port: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .optional()
    .describe("open attach: the control port the user gave"),
  provider: z
    .enum(["fake"])
    .optional()
    .describe(
      'open launch: "fake" connects a local scripted AI provider, so prompts get instant canned replies ("Fake reply N: …") without a login',
    ),
  pane: z.string().min(1).optional().describe("snapshot/act: workspace pane id (default focused)"),
  screenshot: z.boolean().optional().describe("snapshot: also return a PNG"),
  kind: z
    .enum(["type", "press", "click", "send_prompt", "scroll", "select"])
    .optional()
    .describe("act: input kind"),
  text: z
    .string()
    .optional()
    .describe("act type/send_prompt: text; select: the option's label or value"),
  direction: z
    .enum(["up", "down"])
    .optional()
    .describe(
      "act scroll: one wheel step this way, over ref or the window middle; omit it with ref to scroll that element into view",
    ),
  key: z.string().optional().describe("act press: key name such as Enter, Escape, Tab, a"),
  modifiers: z
    .array(z.enum(["alt", "ctrl", "meta", "shift"]))
    .max(4)
    .optional()
    .describe("act press: held modifiers"),
  ref: z
    .string()
    .optional()
    .describe("act type/click/select/scroll: element ref from the latest snapshot, e.g. e7"),
  window: z
    .string()
    .optional()
    .describe("window: id from the window list to switch to; omit it to list the app's windows"),
  expect: ExpectSpec.optional().describe(
    "act: expected result (inferred when omitted); snapshot: wait until it holds, without acting",
  ),
  deadline_ms: z
    .number()
    .int()
    .min(100)
    .max(LAUNCH_MAX_MS)
    .optional()
    .describe(
      `Time limit (act/snapshot/attach default ${ACT_DEFAULT_MS}, max ${ACT_MAX_MS}; launch default ${LAUNCH_DEFAULT_MS}, max ${LAUNCH_MAX_MS})`,
    ),
});

type DevAppArgs = z.infer<typeof DevAppParams>;
type ExpectArgs = z.infer<typeof ExpectSpec>;

export type DevAppErrorCode =
  | "not_attached"
  | "endpoint_refused"
  | "ambiguous_target"
  | "unsupported_platform"
  | "launch_failed"
  | "target_gone"
  | "pane_not_found"
  | "stale_ref"
  | "element_covered"
  | "element_disabled"
  | "element_offscreen"
  | "menu_swallowed_key"
  | "timed_out"
  | "contradicted"
  | "page_unreadable"
  | "invalid_input"
  | "aborted";

const NEXT_STEP: Record<DevAppErrorCode, string> = {
  not_attached:
    'call dev_app open (mode "attach" with the port the user gave, or mode "launch" on Windows)',
  endpoint_refused:
    "check the port belongs to the GG dev app (its Vite page on :1420); use screenshot for other URLs",
  ambiguous_target:
    "close the extra dev app windows so exactly one app page is open, then open again",
  unsupported_platform: 'start the dev app yourself and use open with mode "attach"',
  launch_failed:
    "check gg-app dependencies are installed and the dev app starts (pnpm --filter gg-app tauri dev), then retry",
  target_gone: "call dev_app window to list the app's windows and switch to one, or open again",
  pane_not_found: "take a snapshot without pane, or pass a pane id the page shows",
  stale_ref: "take a new snapshot and use a ref from it",
  element_covered:
    "close what covers it (Escape closes menus and dialogs), take a snapshot, then retry",
  element_disabled:
    "make it enabled first (for example fill required fields) or pick another element",
  element_offscreen: "act scroll with that ref to bring it into view, take a snapshot, then retry",
  menu_swallowed_key:
    'press Escape to close the menu, then press Enter with expect status_is "Working"',
  timed_out:
    "take a snapshot to see the current state; retry with a longer deadline_ms if the app is slow",
  contradicted:
    "take a snapshot, check what actually happened, then adjust the action or expectation",
  page_unreadable: "check any CSS selector you passed, take a snapshot, then retry",
  invalid_input: "fix the arguments and call again",
  aborted: "call again if the work is still needed",
};

/** Message shape: `[code] what happened. Next: what to do`. */
export class DevAppToolError extends Error {
  override name = "DevAppToolError";
  readonly code: DevAppErrorCode;
  constructor(code: DevAppErrorCode, what: string, next: string = NEXT_STEP[code]) {
    super(`[${code}] ${what.replace(/[.\s]+$/, "")}. Next: ${next}.`);
    this.code = code;
  }
}

export interface DevAppConnection {
  port: number;
  session: DevAppSession;
  /** Registry generation of the latest snapshot; refs from any other one are stale. */
  generation: number | null;
}

export type LaunchOutcome =
  { ok: true; session: DevAppSession } | { ok: false; error: unknown; output: string };

/** A launched app that is still starting; it outlives the call that started it. */
export interface PendingLaunch {
  readonly port: number;
  readonly project: string;
  /** Prompts go to the local fake provider instead of a real model. */
  readonly fake: boolean;
  readonly startedAt: number;
  /** Never rejects. */
  readonly outcome: Promise<LaunchOutcome>;
  /** Last lines the dev app printed so far. */
  output(): string;
  cancel(): Promise<void>;
  /** Synchronous kill for process exit. */
  cancelNow(): void;
}

/** Holds the one live dev app connection of an agent session; `shutdown` on dispose. */
export class DevAppManager {
  private connection: DevAppConnection | undefined;
  private pending: PendingLaunch | undefined;

  get current(): DevAppConnection | undefined {
    return this.connection;
  }

  get launching(): PendingLaunch | undefined {
    return this.pending;
  }

  startLaunch(launch: PendingLaunch): void {
    this.pending = launch;
  }

  /** Hands a finished launch to the caller without stopping it. */
  takeLaunch(launch: PendingLaunch): void {
    if (this.pending === launch) this.pending = undefined;
  }

  /** Swaps the connection without stopping the previous one (used to keep ownership on reconnect). */
  set(next: DevAppConnection | undefined): void {
    this.connection = next;
  }

  /** Swaps the connection and stops the previous one (kills its tree only if this session owns it). */
  async replace(next: DevAppConnection | undefined): Promise<DevAppConnection | undefined> {
    const previous = this.connection;
    const launching = this.pending;
    this.connection = next;
    this.pending = undefined;
    try {
      if (previous && previous !== next) await previous.session.stop();
    } finally {
      await launching?.cancel();
    }
    return previous;
  }

  async shutdown(): Promise<void> {
    await this.replace(undefined).catch(() => {});
  }

  /** For `process.on("exit")`: Node runs no awaited work there, so `shutdown` would never kill. */
  shutdownNow(): void {
    const previous = this.connection;
    const launching = this.pending;
    this.connection = undefined;
    this.pending = undefined;
    for (const stop of [() => previous?.session.stopNow(), () => launching?.cancelNow()]) {
      try {
        stop();
      } catch {
        // Exiting anyway; nothing left to report to.
      }
    }
  }
}

export interface DevAppToolDependencies {
  clock?: DriverClock;
  fetch?: FetchLike;
  connect?: (webSocketUrl: string) => Promise<ControlClient>;
  spawn?: SpawnDevApp;
  terminate?: (pid: number) => Promise<void>;
  terminateNow?: (pid: number) => void;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  reservePort?: () => Promise<number>;
  createProfileRoot?: () => Promise<string>;
  removeProfileRoot?: (root: string) => Promise<void>;
  fileExists?: (file: string) => boolean;
  shrinkImage?: (
    buffer: Buffer,
    mediaType: string,
  ) => Promise<{ buffer: Buffer; mediaType: string }>;
  previewImage?: (buffer: Buffer) => Promise<Buffer>;
  now?: () => Date;
  startFakeProvider?: () => Promise<FakeProvider>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = isRecord(address) && typeof address.port === "number" ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Aborting makes time jump past every deadline and wakes every sleep, so waits end at once. */
function abortableClock(base: DriverClock, signal: AbortSignal): DriverClock {
  return {
    now: () => (signal.aborted ? Number.MAX_SAFE_INTEGER / 2 : base.now()),
    sleep: (ms, inner) => base.sleep(ms, inner ? AbortSignal.any([inner, signal]) : signal),
  };
}

const TIMEOUT = Symbol("timeout");

async function within<T>(
  work: Promise<T>,
  ms: number,
  clock: DriverClock,
  what: string,
): Promise<T> {
  work.catch(() => {});
  const stop = new AbortController();
  const timeout = clock.sleep(ms, stop.signal).then(() => TIMEOUT);
  const result = await Promise.race([work, timeout]);
  stop.abort();
  if (result === TIMEOUT)
    throw new DevAppToolError("timed_out", `${what} took longer than ${ms} ms`);
  return result as T;
}

/** The isolated profile moves HOME, so point cargo/rustup back at the user's real toolchain. */
function rustToolchain(env: Record<string, string | undefined>): Record<string, string> {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const toolchain: Record<string, string> = {};
  const cargo = env.CARGO_HOME ?? (home ? path.join(home, ".cargo") : undefined);
  const rustup = env.RUSTUP_HOME ?? (home ? path.join(home, ".rustup") : undefined);
  if (cargo) toolchain.CARGO_HOME = cargo;
  if (rustup) toolchain.RUSTUP_HOME = rustup;
  return toolchain;
}

function budget(requested: number | undefined, fallback: number, max: number): number {
  return Math.min(requested ?? fallback, max);
}

const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;?]*[A-Za-z]`, "g");

/** The end of the launch log without terminal colours; empty when it cannot be read. */
function readLogTail(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.slice(-LAUNCH_LOG_TAIL_CHARS).replace(ANSI, "").replace(/\r/g, "\n");
  } catch {
    return "";
  }
}

function lastLines(text: string, count: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-count)
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}

function stateExpectation(label: string, holds: (page: PageState) => boolean): Expectation {
  return { label, judge: (observed) => (holds(observed.page) ? "met" : "pending") };
}

/** In-page read of a field's text: input/textarea value, else contenteditable text. */
function fieldTextProbe(locator: string): string {
  return `(() => {
    const el = ${locator};
    if (!el || typeof el !== 'object' || typeof el.problem === 'string' || el === document.body) return null;
    if (typeof el.value === 'string' && el.matches('input, textarea')) return el.value;
    return el.isContentEditable === true || el.getAttribute('contenteditable') === 'true' ? el.textContent : null;
  })()`;
}

function valueGrew(locator: string, text: string, label: string): Expectation {
  return {
    label,
    probe: fieldTextProbe(locator),
    judge(observed, baseline) {
      if (typeof baseline.probe !== "string") {
        return { contradicted: "no text field is focused or targeted" };
      }
      const now = observed.probe;
      return typeof now === "string" &&
        now.length === baseline.probe.length + text.length &&
        now.includes(text)
        ? "met"
        : "pending";
    },
  };
}

/** In-page text of an option as the snapshot shows it. */
const OPTION_LABEL = `(o) => String(o.textContent || '').replace(/\\s+/g, ' ').trim()`;

/** Chooses an option in a native dropdown the way a user's pick does: selection, then input/change events. */
function selectOptionScript(locator: string, want: string): string {
  return `(() => {
    const el = ${locator};
    if (!el || typeof el !== 'object') return { problem: 'element not found', block: 'missing' };
    if (typeof el.problem === 'string') return el;
    if (el.tagName !== 'SELECT') return { problem: 'it is not a native dropdown; click it, take a snapshot, then click the option', block: 'invalid' };
    if (el.disabled === true || el.hasAttribute('disabled')) return { problem: 'the dropdown is disabled', block: 'disabled' };
    const want = ${JSON.stringify(want)};
    const label = ${OPTION_LABEL};
    const options = [...el.querySelectorAll('option')];
    const match = options.find((o) => label(o) === want) || options.find((o) => o.getAttribute('value') === want);
    if (!match) return { problem: 'no option ' + JSON.stringify(want) + ' (options: ' + options.slice(0, 12).map(label).join(', ') + ')', block: 'invalid' };
    if (match.disabled === true || match.hasAttribute('disabled')) return { problem: 'option ' + JSON.stringify(want) + ' is disabled', block: 'disabled' };
    el.focus();
    match.selected = true;
    const View = el.ownerDocument.defaultView;
    el.dispatchEvent(new View.Event('input', { bubbles: true }));
    el.dispatchEvent(new View.Event('change', { bubbles: true }));
    return 'done';
  })()`;
}

function optionChosen(locator: string, want: string): Expectation {
  return condition(
    `the dropdown shows ${quote(want)}`,
    `(() => {
      const el = ${locator};
      if (!el || typeof el.problem === 'string' || el.tagName !== 'SELECT') return false;
      const o = (el.selectedOptions && el.selectedOptions[0]) || el.querySelector('option[selected]') || el.querySelector('option');
      return Boolean(o) && ((${OPTION_LABEL})(o) === ${JSON.stringify(want)} || o.getAttribute('value') === ${JSON.stringify(want)});
    })()`,
  );
}

function scrollIntoViewScript(locator: string): string {
  return `(() => {
    const el = ${locator};
    if (!el || typeof el !== 'object') return { problem: 'element not found', block: 'missing' };
    if (typeof el.problem === 'string') return el;
    if (typeof el.scrollIntoView !== 'function') return { problem: 'the element cannot scroll into view', block: 'invalid' };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return 'done';
  })()`;
}

function inView(locator: string, ref: string): Expectation {
  return condition(
    `${ref} is in view`,
    `(() => {
      const el = ${locator};
      if (!el || typeof el.problem === 'string') return false;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    })()`,
  );
}

/** Every scrolled element and its offset, so any scroll anywhere shows up as a change. */
const SCROLL_POSITIONS = `(() => {
  const out = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const top = Math.round(Number(el.scrollTop) || 0), left = Math.round(Number(el.scrollLeft) || 0);
    if (top || left) out.push(el.tagName + '.' + String(el.className || '').slice(0, 40) + ':' + top + ',' + left);
  }
  return out.join(' ');
})()`;

function scrolled(direction: "up" | "down"): Expectation {
  return {
    label: `something scrolled ${direction}`,
    probe: SCROLL_POSITIONS,
    judge: (observed, baseline) => (observed.probe !== baseline.probe ? "met" : "pending"),
    describeTimeout: () =>
      `nothing scrolled (already at the ${direction === "down" ? "bottom" : "top"}, or nothing scrollable there)`,
  };
}

function windowId(target: DevTarget): string {
  return `w${(target.id ?? "").slice(0, 8).toLowerCase()}`;
}

function windowLabel(target: DevTarget): string {
  if (/whatsnew/i.test(target.url)) return "What's new window";
  return target.title ? `window ${quote(target.title)}` : "app window";
}

function snapOf(observation: Observation | null): string[] {
  const probe = observation?.probe;
  if (!isRecord(probe) || !("snap" in probe)) return [];
  const snapshot = parseSnapshot(probe.snap);
  return typeof snapshot === "string" ? [] : snapshot.elements.map(describeElement);
}

/** Every expectation also records the element list, so results can say what appeared or went. */
function withElements(expectation: Expectation, pane: PaneSelector): Expectation {
  const unwrap = (observation: Observation): Observation => ({
    page: observation.page,
    probe: isRecord(observation.probe) ? (observation.probe.inner ?? null) : null,
  });
  const describeTimeout = expectation.describeTimeout;
  return {
    ...expectation,
    probe: `({ inner: ${expectation.probe ?? "null"}, snap: ${snapshotScript({ pane, register: false })} })`,
    judge: (observed, baseline) => expectation.judge(unwrap(observed), unwrap(baseline)),
    ...(describeTimeout
      ? {
          describeTimeout: (observed: Observation, baseline: Observation) =>
            describeTimeout(unwrap(observed), unwrap(baseline)),
        }
      : {}),
  };
}

function focusText(page: PageState): string {
  const focused = page.focused;
  if (!focused) return "nothing";
  return `${focused.tag}${focused.label ? ` ${quote(focused.label)}` : ""}`;
}

function describeChanges(baseline: Observation | null, observed: Observation | null): string[] {
  if (!baseline || !observed) return [];
  const before = baseline.page;
  const after = observed.page;
  const changes: string[] = [];
  const field = (name: string, from: string, to: string): void => {
    if (from !== to) changes.push(`${name} ${from} → ${to}`);
  };
  field(
    "draft",
    before.draft === null ? "none" : quote(before.draft),
    after.draft === null ? "none" : quote(after.draft),
  );
  field("menu", before.menuOpen ? "open" : "closed", after.menuOpen ? "open" : "closed");
  field("dialog", before.modalOpen ? "open" : "closed", after.modalOpen ? "open" : "closed");
  field("status", before.status ?? "none", after.status ?? "none");
  field("phase", before.phase ?? "none", after.phase ?? "none");
  field("queued", String(before.queued), String(after.queued));
  field(
    "composer",
    before.composerDisabled ? "disabled" : "enabled",
    after.composerDisabled ? "disabled" : "enabled",
  );
  field("focus", focusText(before), focusText(after));
  const remaining = new Map<string, number>();
  for (const line of snapOf(baseline)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of snapOf(observed)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  const removed = [...remaining].flatMap(([line, count]) => Array<string>(count).fill(line));
  changes.push(...added.map((line) => `+ ${line}`), ...removed.map((line) => `- ${line}`));
  if (changes.length <= MAX_CHANGE_LINES) return changes;
  return [
    ...changes.slice(0, MAX_CHANGE_LINES),
    `${changes.length - MAX_CHANGE_LINES} more changes not shown`,
  ];
}

function formatOutcome(outcome: ActionOutcome): string {
  const changes = describeChanges(outcome.baseline, outcome.observed);
  return [
    `${outcome.verdict}: ${outcome.action} — ${outcome.expectation}`,
    `reason: ${outcome.reason}`,
    changes.length > 0
      ? `changed:\n${changes.map((line) => `  ${line}`).join("\n")}`
      : "changed: nothing visible",
    `elapsed ${outcome.elapsedMs} ms`,
  ].join("\n");
}

interface ActContext {
  client: ControlClient;
  kind: string;
  key?: string | undefined;
  explicit: boolean;
}

function fromActionError(error: DevAppActionError, context: ActContext): DevAppToolError {
  const outcome = error.outcome;
  const seen = outcome.observed ?? outcome.baseline;
  const saw = seen ? `; saw ${describePageState(seen.page)}` : "";
  const what = `${outcome.action} ${outcome.verdict} (${outcome.expectation}): ${outcome.reason}`;
  // An open dialog sits over the composer, so the prompt never reached it.
  const behindDialog =
    outcome.verdict === "contradicted" &&
    outcome.baseline?.page.modalOpen === true &&
    context.kind === "send_prompt";
  if (behindDialog && outcome.blockedBy !== "stale" && outcome.blockedBy !== "missing") {
    return new DevAppToolError("element_covered", `${what}${saw}`);
  }
  switch (outcome.blockedBy) {
    case "stale":
    case "missing":
      return new DevAppToolError("stale_ref", what);
    case "covered":
      return new DevAppToolError("element_covered", what);
    case "disabled":
      return new DevAppToolError("element_disabled", what);
    case "offscreen":
      return new DevAppToolError("element_offscreen", what);
    case "unfocusable":
      return new DevAppToolError("contradicted", `${what}${saw}`);
    case "invalid":
      return new DevAppToolError("invalid_input", what);
    default:
      break;
  }
  if (context.client.goneReason !== null) return new DevAppToolError("target_gone", what);
  if (outcome.reason.includes("the pane is not on the page")) {
    return new DevAppToolError("pane_not_found", what);
  }
  if (outcome.verdict === "unreadable") {
    if (/deadline/.test(outcome.reason)) return new DevAppToolError("timed_out", `${what}${saw}`);
    return new DevAppToolError("page_unreadable", what);
  }
  const menuOpen =
    outcome.baseline?.page.menuOpen === true || outcome.observed?.page.menuOpen === true;
  const keyToMenu =
    context.kind === "send_prompt" ||
    (context.kind === "press" && context.key !== "Escape" && !context.explicit);
  if (menuOpen && keyToMenu) return new DevAppToolError("menu_swallowed_key", `${what}${saw}`);
  if (outcome.reason.startsWith("not met within")) {
    return new DevAppToolError("timed_out", `${what}${saw}`);
  }
  return new DevAppToolError("contradicted", `${what}${saw}`);
}

function findAppDir(cwd: string, exists: (file: string) => boolean): string | null {
  for (const dir of [cwd, path.join(cwd, "gg-app")]) {
    if (exists(path.join(dir, "src-tauri", "tauri.local.conf.json"))) return dir;
  }
  return null;
}

export function createDevAppTool(
  cwd: string,
  manager: DevAppManager,
  planModeRef?: { current: boolean },
  deps: DevAppToolDependencies = {},
): AgentTool<typeof DevAppParams> {
  const baseClock = deps.clock ?? systemClock;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const connect =
    deps.connect ??
    ((url: string): Promise<ControlClient> =>
      DevCdpClient.connect(url, { requestTimeoutMs: REQUEST_TIMEOUT_MS }));
  const reservePort = deps.reservePort ?? reserveLoopbackPort;
  const createProfileRoot =
    deps.createProfileRoot ?? (() => mkdtemp(path.join(tmpdir(), "gg-dev-app-")));
  const removeProfileRoot =
    deps.removeProfileRoot ??
    ((root: string) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const fileExists = deps.fileExists ?? existsSync;
  const shrinkImage = deps.shrinkImage ?? shrinkToFit;
  const previewImage = deps.previewImage ?? downscaleForPreview;
  const now = deps.now ?? (() => new Date());
  const startProvider = deps.startFakeProvider ?? startFakeProvider;
  const hiddenPaths = new Set<string>();

  function scrub(text: string): string {
    let result = text.replace(/\bwss?:\/\/\S+/gi, "[debugger address hidden]");
    for (const hidden of hiddenPaths) result = result.split(hidden).join("[profile]");
    return redactText(result, { secrets: environmentSecrets(env) });
  }

  /** Loopback-only, and only the port that was asked for. */
  function guardedConnect(port: number) {
    return (url: string): Promise<ControlClient> => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DevAppToolError(
          "endpoint_refused",
          "the app page reported an unusable debugger address",
        );
      }
      if (
        parsed.protocol !== "ws:" ||
        !LOOPBACK_HOSTS.has(parsed.hostname) ||
        Number(parsed.port) !== port
      ) {
        throw new DevAppToolError(
          "endpoint_refused",
          `the app page's debugger is not on this machine's loopback port ${port}`,
        );
      }
      parsed.hostname = "127.0.0.1";
      return connect(parsed.toString());
    };
  }

  function stillStarting(launching: PendingLaunch): DevAppToolError {
    return new DevAppToolError(
      "not_attached",
      `the dev app is still starting (${duration(baseClock.now() - launching.startedAt)} so far)`,
      'call open with mode "launch" again to wait for it',
    );
  }

  function requireConnection(): DevAppConnection {
    const connection = manager.current;
    const launching = manager.launching;
    if (!connection && launching) throw stillStarting(launching);
    if (!connection) throw new DevAppToolError("not_attached", "no dev app connection is open");
    const gone = connection.session.client.goneReason;
    if (gone !== null) throw new DevAppToolError("target_gone", `the app page went away (${gone})`);
    return connection;
  }

  function refLocator(connection: DevAppConnection, ref: string): string {
    if (!isRef(ref))
      throw new DevAppToolError("invalid_input", `${JSON.stringify(ref)} is not a ref like e7`);
    if (connection.generation === null) {
      throw new DevAppToolError(
        "stale_ref",
        `${ref} cannot be used before a snapshot on this connection`,
      );
    }
    return refLocatorScript(ref, connection.generation);
  }

  async function snapshot(
    connection: DevAppConnection,
    pane: PaneSelector,
    ms: number,
    clock: DriverClock,
  ): Promise<string> {
    const driver = createDevAppDriver({ client: connection.session.client, clock, deadlineMs: ms });
    let outcome: ActionOutcome;
    try {
      outcome = await driver.waitFor(
        "snapshot",
        {
          label: "snapshot",
          probe: snapshotScript({ pane, register: true }),
          judge: () => "met",
        },
        { pane, deadlineMs: ms },
      );
    } catch (error) {
      if (error instanceof DevAppActionError) {
        throw fromActionError(error, {
          client: connection.session.client,
          kind: "snapshot",
          explicit: true,
        });
      }
      throw error;
    }
    const observed = outcome.observed;
    const parsed = parseSnapshot(observed?.probe);
    if (typeof parsed === "string" || !observed) {
      if (parsed === "pane not found") {
        throw new DevAppToolError("pane_not_found", `no pane ${JSON.stringify(pane)} on the page`);
      }
      throw new DevAppToolError("page_unreadable", `the snapshot failed (${String(parsed)})`);
    }
    connection.generation = parsed.generation;
    return formatSnapshot(observed.page, parsed);
  }

  async function screenshotResult(
    connection: DevAppConnection,
    text: string,
    ms: number,
    clock: DriverClock,
  ): Promise<StructuredToolResult> {
    const raw = await within(
      captureScreenshot(connection.session.client),
      ms,
      clock,
      "the screenshot",
    );
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const relative = path.join(".gg", "screenshots", `dev-app-${stamp}.png`);
    const outPath = path.join(cwd, relative);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, raw);
    let fitted: { buffer: Buffer; mediaType: string };
    try {
      fitted = await shrinkImage(raw, "image/png");
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: scrub(
              `${text}\n\nScreenshot saved to ${relative} but could not be prepared for viewing: ${message(error)}`,
            ),
          },
        ],
      };
    }
    const preview = await previewImage(fitted.buffer).catch(() => fitted.buffer);
    return {
      content: [
        { type: "text", text: scrub(`${text}\n\nScreenshot: ${relative} [${fitted.mediaType}]`) },
        { type: "image", mediaType: fitted.mediaType, data: fitted.buffer.toString("base64") },
      ],
      details: {
        outPath,
        imagePreviews: [
          { base64: preview.toString("base64"), mediaType: fitted.mediaType, path: outPath },
        ],
      },
    };
  }

  /** A freshly launched window is blank for a few seconds; snapshotting it then misleads the next act. */
  async function waitForContent(
    connection: DevAppConnection,
    ms: number,
    clock: DriverClock,
  ): Promise<void> {
    if (ms <= 0) return;
    const driver = createDevAppDriver({ client: connection.session.client, clock, deadlineMs: ms });
    try {
      await driver.waitFor(
        "the app to render",
        {
          label: "the app shows interactive elements",
          probe: snapshotScript({ register: false }),
          judge: (observed) => {
            const parsed = parseSnapshot(observed.probe);
            return typeof parsed !== "string" && parsed.elements.length > 0 ? "met" : "pending";
          },
        },
        { deadlineMs: ms },
      );
    } catch (error) {
      if (!(error instanceof DevAppActionError)) throw error;
    }
  }

  /** Returns true when it had to open an agent pane (the composer is then ready, or time ran out). */
  async function ensureAgentPane(
    connection: DevAppConnection,
    cwd: string,
    ms: number,
    clock: DriverClock,
  ): Promise<boolean> {
    const { client } = connection.session;
    const end = clock.now() + ms;
    let seeded = false;
    let checkReady = false;
    for (;;) {
      const remaining = end - clock.now();
      if (remaining <= 0 || client.goneReason !== null) return seeded;
      try {
        if (!seeded && !checkReady) {
          const result = await within(
            client.evaluate(seedAgentPaneScript(cwd)),
            remaining,
            clock,
            "opening an agent pane",
          );
          if (result === "seeded") seeded = checkReady = true;
          else if (result === "has-pane") checkReady = true;
          else if (result !== "missing") return false;
        } else {
          const state = parsePageState(
            await within(client.evaluate(observeScript()), remaining, clock, "reading the pane"),
          );
          // The composer renders before the session loads, and Enter is ignored until it has.
          const loading = await within(
            client.evaluate(PANE_LOADING_SCRIPT),
            remaining,
            clock,
            "reading the pane",
          );
          if (state?.paneFound && state.draft !== null && loading === false) return seeded;
        }
      } catch {
        // The page reloads after seeding; reads fail until it is back.
      }
      await clock.sleep(Math.min(100, Math.max(0, end - clock.now())));
    }
  }

  async function firstSnapshot(
    connection: DevAppConnection,
    header: string,
    clock: DriverClock,
    ms = ACT_DEFAULT_MS,
  ) {
    if (ms < 100) return `${header}\n\nNo time was left for a first snapshot; take one now.`;
    try {
      return `${header}\n\n${await snapshot(connection, null, ms, clock)}`;
    } catch (error) {
      return `${header}\n\nFirst snapshot failed: ${message(error)}`;
    }
  }

  async function startLaunch(
    appDir: string,
    tauriCli: string,
    fake: boolean,
  ): Promise<PendingLaunch> {
    const port = await reservePort();
    const root = await createProfileRoot();
    hiddenPaths.add(root);
    let profile: IsolatedProfile;
    let logFd: number;
    let provider: FakeProvider | null = null;
    const logFile = path.join(root, "launch.log");
    try {
      profile = createIsolatedProfile(root);
      if (fake) {
        provider = await startProvider();
        configureFakeProvider(profile, LOCAL_FORK_IDENTITY);
      }
      logFd = openSync(logFile, "a");
    } catch (error) {
      await provider?.close().catch(() => {});
      await removeProfileRoot(root).catch(() => {});
      throw new DevAppToolError("launch_failed", `the isolated profile failed (${message(error)})`);
    }
    const providerEnv: Record<string, string> = provider
      ? {
          GG_SIDECAR_PATH: path.join(appDir, FAKE_PROVIDER_SIDECAR),
          GG_DEV_APP_REPLAY_MODE: "sidecar",
          GG_DEV_APP_REPLAY_PROVIDER: provider.url,
        }
      : {};
    const closeProvider = async (): Promise<void> => {
      await provider?.close().catch(() => {});
    };
    const closeLog = (): void => {
      try {
        closeSync(logFd);
      } catch {
        // Already closed.
      }
    };
    const controller = new AbortController();
    let pid: number | null = null;
    let settled: LaunchOutcome | null = null;
    let ready: Promise<DevAppSession>;
    try {
      ready = launchDevApp({
        appDir,
        configPath: path.join(appDir, "src-tauri", "tauri.local.conf.json"),
        env: devAppEnvironment(env, profile, {
          cdpPort: port,
          extra: { ...rustToolchain(env), ...providerEnv },
        }),
        cdpPort: port,
        readyDeadlineMs: LAUNCH_READY_MS,
        stdio: ["ignore", logFd, logFd],
        tauriCli,
        // Not the call's clock: the app keeps starting after the call that launched it returns.
        clock: abortableClock(baseClock, controller.signal),
        connect: guardedConnect(port),
        onSpawn: (spawned) => {
          pid = spawned;
        },
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
        ...(deps.terminate ? { terminate: deps.terminate } : {}),
        ...(deps.terminateNow ? { terminateNow: deps.terminateNow } : {}),
      });
    } catch (error) {
      ready = Promise.reject(error);
    }
    const outcome = ready.then(
      (session): LaunchOutcome => {
        closeLog();
        return {
          ok: true,
          session: {
            ...session,
            stop: async () => {
              try {
                await session.stop();
              } finally {
                await closeProvider();
                await removeProfileRoot(root).catch(() => {});
              }
            },
            stopNow: () => {
              session.stopNow();
              void closeProvider();
            },
          },
        };
      },
      async (error: unknown): Promise<LaunchOutcome> => {
        closeLog();
        const output = readLogTail(logFile);
        await closeProvider();
        await removeProfileRoot(root).catch(() => {});
        return { ok: false, error, output };
      },
    );
    void outcome.then((result) => {
      settled = result;
    });
    return {
      port,
      project: profile.project,
      fake,
      startedAt: baseClock.now(),
      outcome,
      output: () => readLogTail(logFile),
      cancel: async () => {
        controller.abort();
        const result = await outcome;
        if (result.ok) await result.session.stop();
      },
      cancelNow: () => {
        controller.abort();
        const result: LaunchOutcome | null = settled;
        if (result?.ok) result.session.stopNow();
        else if (pid !== null) (deps.terminateNow ?? killProcessTree)(pid);
        void closeProvider();
      },
    };
  }

  function launchFailure(result: Extract<LaunchOutcome, { ok: false }>): DevAppToolError {
    const { error } = result;
    if (error instanceof DevAppToolError) return error;
    if (error instanceof AmbiguousTargetError) {
      return new DevAppToolError("ambiguous_target", error.message);
    }
    const lines = lastLines(result.output, 6);
    const output = lines.length > 0 ? `; its last output:\n${lines.join("\n")}\n` : "";
    return new DevAppToolError(
      "launch_failed",
      `the dev app did not become ready (${message(error)})${output}`,
    );
  }

  /** Waits for a launch within this call; when it is not ready yet, reports progress instead of failing. */
  async function awaitLaunch(
    pending: PendingLaunch,
    args: DevAppArgs,
    clock: DriverClock,
    signal: AbortSignal,
    resumed: boolean,
  ): Promise<string> {
    const ms = budget(args.deadline_ms, LAUNCH_DEFAULT_MS, LAUNCH_MAX_MS);
    const end = clock.now() + ms;
    const readyWait = ms - Math.min(LAUNCH_FINISH_RESERVE_MS, Math.floor(ms / 4));
    const stop = new AbortController();
    const result = await Promise.race([
      pending.outcome,
      clock.sleep(readyWait, stop.signal).then(() => null),
    ]);
    stop.abort();
    const elapsed = duration(baseClock.now() - pending.startedAt);
    if (result === null) {
      if (signal.aborted) {
        throw new DevAppToolError(
          "aborted",
          `stopped waiting after ${elapsed}; the dev app keeps starting in the background`,
          'call open with mode "launch" again to keep waiting, or close to stop it',
        );
      }
      const latest = lastLines(pending.output(), 1)[0];
      return [
        `The dev app is still starting (${elapsed} so far; a Rust rebuild can take several minutes). It keeps starting in the background.`,
        latest ? `Latest output: ${latest}` : "No output yet.",
        'Next: call open with mode "launch" again to keep waiting (it does not start a second app), or close to stop it.',
      ].join("\n");
    }
    manager.takeLaunch(pending);
    if (!result.ok) throw launchFailure(result);
    const connection: DevAppConnection = {
      port: pending.port,
      session: result.session,
      generation: null,
    };
    await manager.replace(connection);
    // Keep a second of the budget for the snapshot itself.
    await waitForContent(connection, Math.min(RENDER_WAIT_MS, end - clock.now() - 1000), clock);
    const opened = await ensureAgentPane(
      connection,
      pending.project,
      Math.min(RENDER_WAIT_MS, end - clock.now() - 1000),
      clock,
    );
    const pane = opened
      ? ` Its workspace was empty, so a Code agent pane was opened on an empty scratch project${pending.fake ? "" : " (the isolated profile is signed out)"}.`
      : "";
    const took = resumed ? ` It took ${elapsed} to start.` : "";
    const provider = pending.fake
      ? ' Prompts go to a fake local AI provider that answers "Fake reply N: <start of your message>"; no real model or login.'
      : "";
    return firstSnapshot(
      connection,
      `Launched the dev app with an isolated profile (control port ${pending.port}); this session owns it, and close stops it.${took}${pane}${provider}`,
      clock,
      Math.min(ACT_DEFAULT_MS, end - clock.now()),
    );
  }

  async function launch(
    args: DevAppArgs,
    clock: DriverClock,
    signal: AbortSignal,
  ): Promise<string> {
    if (platform !== "win32") {
      throw new DevAppToolError(
        "unsupported_platform",
        `launching the dev app needs Windows (this is ${platform})`,
      );
    }
    const fake = args.provider === "fake";
    const resumed = manager.launching;
    if (resumed && resumed.fake !== fake) {
      throw new DevAppToolError(
        "invalid_input",
        `a launch ${resumed.fake ? "with" : "without"} the fake provider is already starting`,
        `call open launch ${resumed.fake ? 'with provider "fake"' : "without provider"} to keep waiting, or close it first`,
      );
    }
    if (resumed) return awaitLaunch(resumed, args, clock, signal, true);
    const appDir = findAppDir(cwd, fileExists);
    if (!appDir) {
      throw new DevAppToolError(
        "launch_failed",
        "no gg-app/src-tauri/tauri.local.conf.json in the working directory",
        "run from the repository root or the gg-app folder",
      );
    }
    const tauriCli = path.join(appDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
    if (!fileExists(tauriCli)) {
      throw new DevAppToolError(
        "launch_failed",
        "the Tauri CLI is not installed in gg-app",
        "run pnpm install, then retry",
      );
    }
    if (fake && !fileExists(path.join(appDir, FAKE_PROVIDER_SIDECAR))) {
      throw new DevAppToolError(
        "launch_failed",
        "the fake provider's daemon wrapper is missing from gg-app/scripts",
        "launch without provider, or restore the replay smoke script",
      );
    }
    await manager.replace(undefined);
    const pending = await startLaunch(appDir, tauriCli, fake);
    manager.startLaunch(pending);
    return awaitLaunch(pending, args, clock, signal, false);
  }

  async function attach(
    args: DevAppArgs,
    clock: DriverClock,
    signal: AbortSignal,
  ): Promise<string> {
    const current = manager.current;
    const port = args.port ?? (current?.session.owned ? current.port : undefined);
    const launching = manager.launching;
    if (port === undefined && launching) throw stillStarting(launching);
    if (port === undefined) {
      throw new DevAppToolError(
        "endpoint_refused",
        "attach needs the control port the user gave (no dev app was launched in this session)",
        'ask the user which port the dev app exposes, or use mode "launch"',
      );
    }
    if (current && current.port === port && current.session.client.goneReason === null) {
      return firstSnapshot(current, `Already connected to the dev app on port ${port}.`, clock);
    }
    const ms = budget(args.deadline_ms, ACT_DEFAULT_MS, ACT_MAX_MS);
    let attached: DevAppSession;
    try {
      attached = await attachDevApp({
        cdpPort: port,
        deadlineMs: ms,
        clock,
        connect: guardedConnect(port),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw new DevAppToolError("aborted", "attaching was cancelled");
      if (error instanceof DevAppToolError) throw error;
      if (error instanceof AmbiguousTargetError)
        throw new DevAppToolError("ambiguous_target", error.message);
      throw new DevAppToolError(
        "endpoint_refused",
        `no single GG dev app page answered on 127.0.0.1:${port} (${message(error)})`,
      );
    }
    if (current && current.port === port && current.session.owned) {
      // Reconnecting to the app this session launched keeps the right to stop it.
      const owner = current.session;
      const session: DevAppSession = {
        ...attached,
        owned: true,
        pid: owner.pid,
        stop: async () => {
          attached.client.close();
          await owner.stop();
        },
        stopNow: () => {
          attached.client.close();
          owner.stopNow();
        },
      };
      const connection: DevAppConnection = { port, session, generation: null };
      manager.set(connection);
      return firstSnapshot(
        connection,
        `Reconnected to the dev app this session launched (port ${port}).`,
        clock,
      );
    }
    const connection: DevAppConnection = { port, session: attached, generation: null };
    await manager.replace(connection);
    return firstSnapshot(
      connection,
      `Attached to the dev app on port ${port} (${attached.target.url}). This session did not start it, so close leaves it running.`,
      clock,
    );
  }

  function explicitExpectation(spec: ExpectArgs, connection: DevAppConnection): Expectation {
    const value = (): string => {
      if (spec.value === undefined || (spec.kind !== "draft_equals" && spec.value === "")) {
        throw new DevAppToolError("invalid_input", `expect ${spec.kind} needs a value`);
      }
      return spec.value;
    };
    switch (spec.kind) {
      case "text_appears":
        return textAppears(value());
      case "text_gone":
        return textGone(value());
      case "element_appears": {
        const selector = value();
        if (isRef(selector)) {
          throw new DevAppToolError(
            "invalid_input",
            "element_appears needs a CSS selector, not a ref",
          );
        }
        return elementAppears(selector);
      }
      case "element_gone": {
        const target = value();
        if (!isRef(target)) return elementGone(target);
        const locator = refLocator(connection, target);
        return condition(
          `${target} is gone`,
          `(() => { const el = ${locator}; return !el || typeof el.problem === 'string' || !el.isConnected; })()`,
        );
      }
      case "draft_equals":
        return draftEquals(value());
      case "focus_on": {
        const target = value();
        if (!isRef(target)) return focusOn(target);
        const locator = refLocator(connection, target);
        return condition(
          `focus is on ${target}`,
          `(() => ${locator})() === document.activeElement`,
        );
      }
      case "menu_open":
        return stateExpectation("a menu is open", (page) => page.menuOpen);
      case "menu_closed":
        return stateExpectation("no menu is open", (page) => !page.menuOpen);
      case "dialog_open":
        return stateExpectation("a dialog is open", (page) => page.modalOpen);
      case "dialog_closed":
        return stateExpectation("no dialog is open", (page) => !page.modalOpen);
      case "status_is": {
        const status = value();
        return stateExpectation(
          `pane status is ${quote(status)}`,
          (page) => page.status === status,
        );
      }
    }
  }

  /** Read-only wait for a result (for example reply text), so no sleep or log watcher is needed. */
  async function waitThenSnapshot(
    connection: DevAppConnection,
    spec: ExpectArgs,
    pane: PaneSelector,
    ms: number,
    clock: DriverClock,
  ): Promise<string> {
    const expectation = explicitExpectation(spec, connection);
    const end = clock.now() + ms;
    const client = connection.session.client;
    const driver = createDevAppDriver({ client, clock, deadlineMs: ms });
    let outcome: ActionOutcome;
    try {
      outcome = await driver.waitFor(expectation.label, withElements(expectation, pane), {
        pane,
        deadlineMs: ms,
      });
    } catch (error) {
      if (error instanceof DevAppActionError) {
        throw fromActionError(error, { client, kind: "snapshot", explicit: true });
      }
      throw error;
    }
    const left = end - clock.now();
    if (left < 100) {
      return `${formatOutcome(outcome)}

No time was left for a snapshot; take one now.`;
    }
    return `${formatOutcome(outcome)}

${await snapshot(connection, pane, left, clock)}`;
  }

  async function act(args: DevAppArgs, clock: DriverClock): Promise<string> {
    const connection = requireConnection();
    const kind = args.kind;
    if (!kind) throw new DevAppToolError("invalid_input", "act needs kind");
    if (args.ref !== undefined && (kind === "press" || kind === "send_prompt")) {
      throw new DevAppToolError(
        "invalid_input",
        `${kind} does not take ref; click the element first (or use type with ref), then press`,
      );
    }
    const wheel = kind === "scroll" ? args.direction : undefined;
    const ms = budget(
      args.deadline_ms,
      wheel !== undefined ? SCROLL_DEFAULT_MS : ACT_DEFAULT_MS,
      ACT_MAX_MS,
    );
    const end = clock.now() + ms;
    const remaining = (): number => {
      const left = end - clock.now();
      if (left <= 0)
        throw new DevAppToolError("timed_out", `the ${ms} ms deadline passed before acting`);
      return left;
    };
    const pane: PaneSelector = args.pane ?? null;
    const client = connection.session.client;
    const locator = args.ref !== undefined ? refLocator(connection, args.ref) : undefined;
    const text = args.text ?? "";
    if ((kind === "type" || kind === "send_prompt") && text.trim() === "") {
      throw new DevAppToolError("invalid_input", `${kind} needs non-empty text`);
    }
    if (kind === "click" && locator === undefined) {
      throw new DevAppToolError("invalid_input", "click needs ref from the latest snapshot");
    }
    if (kind === "select" && (locator === undefined || text === "")) {
      throw new DevAppToolError(
        "invalid_input",
        "select needs ref (a dropdown from the latest snapshot) and text (the option's label or value)",
      );
    }
    if (kind === "scroll" && locator === undefined && wheel === undefined) {
      throw new DevAppToolError(
        "invalid_input",
        "scroll needs direction (up or down), or ref to scroll that element into view",
      );
    }
    if (kind === "press") {
      if (!args.key) throw new DevAppToolError("invalid_input", "press needs key");
      try {
        resolveKey(args.key);
      } catch (error) {
        throw new DevAppToolError("invalid_input", message(error));
      }
    }
    const driver = createDevAppDriver({ client, clock, deadlineMs: ms });
    const context: ActContext = {
      client,
      kind,
      key: args.key,
      explicit: args.expect !== undefined,
    };
    const explicit = args.expect ? explicitExpectation(args.expect, connection) : null;

    async function before(): Promise<PageState> {
      try {
        return await within(driver.observe(pane), remaining(), clock, "reading the page");
      } catch (error) {
        if (error instanceof DevAppToolError) throw error;
        if (client.goneReason !== null) throw new DevAppToolError("target_gone", message(error));
        if (/deadline/.test(message(error))) throw new DevAppToolError("timed_out", message(error));
        throw new DevAppToolError("page_unreadable", message(error));
      }
    }

    async function inferred(): Promise<Expectation> {
      if (kind === "click") return pageChanged(pane);
      if (kind === "select") return optionChosen(locator ?? "null", text);
      if (kind === "scroll") {
        return wheel !== undefined ? scrolled(wheel) : inView(locator ?? "null", args.ref ?? "");
      }
      if (kind === "press") {
        const page = await before();
        if (args.key === "Escape" && page.menuOpen) {
          return stateExpectation("the menu closed", (state) => !state.menuOpen);
        }
        if (args.key === "Escape" && page.modalOpen) {
          return stateExpectation("the dialog closed", (state) => !state.modalOpen);
        }
        return pageChanged(pane);
      }
      const target = locator ?? "document.activeElement";
      const isComposer = await within(
        client.evaluate(
          `(() => { const el = ${target}; return Boolean(el && typeof el.matches === 'function' && el.matches('textarea.input')); })()`,
        ),
        remaining(),
        clock,
        "reading the page",
      );
      if (isComposer === true) {
        const page = await before();
        if (page.draft !== null) return draftEquals(page.draft + text);
      }
      return valueGrew(target, text, `${args.ref ?? "the focused field"} gains ${quote(text)}`);
    }

    try {
      if (kind === "send_prompt") {
        const sent = await driver.sendPrompt(text, { pane, deadlineMs: remaining() });
        if (!explicit) return formatOutcome(sent);
        const after = await driver.waitFor(explicit.label, withElements(explicit, pane), {
          pane,
          deadlineMs: remaining(),
        });
        return `${formatOutcome(sent)}\n\n${formatOutcome(after)}`;
      }
      const expect = withElements(explicit ?? (await inferred()), pane);
      const options = { pane, deadlineMs: remaining(), expect };
      let outcome: ActionOutcome;
      if (kind === "type") {
        outcome = await driver.type(text, {
          ...options,
          ...(locator ? { intoElement: locator } : {}),
        });
      } else if (kind === "press") {
        outcome = await driver.press(args.key ?? "", {
          ...options,
          ...(args.modifiers ? { modifiers: args.modifiers } : {}),
        });
      } else if (kind === "select") {
        outcome = await driver.perform(
          `select ${quote(text)} in ${args.ref ?? ""}`,
          selectOptionScript(locator ?? "null", text),
          options,
        );
      } else if (kind === "scroll" && wheel !== undefined) {
        outcome = await driver.wheel(
          `scroll ${wheel}${args.ref ? ` over ${args.ref}` : ""}`,
          locator ?? null,
          wheel === "down" ? WHEEL_STEP_PX : -WHEEL_STEP_PX,
          options,
        );
      } else if (kind === "scroll") {
        outcome = await driver.perform(
          `scroll ${args.ref ?? ""} into view`,
          scrollIntoViewScript(locator ?? "null"),
          options,
        );
      } else {
        outcome = await driver.clickElement(`click ${args.ref ?? ""}`, locator ?? "null", options);
      }
      return formatOutcome(outcome);
    } catch (error) {
      if (error instanceof DevAppActionError) throw fromActionError(error, context);
      throw error;
    }
  }

  /** Lists the app's windows, or moves this connection to one of them (ownership is kept). */
  async function windows(args: DevAppArgs, clock: DriverClock): Promise<string> {
    const connection = manager.current;
    const launching = manager.launching;
    if (!connection && launching) throw stillStarting(launching);
    if (!connection) throw new DevAppToolError("not_attached", "no dev app connection is open");
    const ms = budget(args.deadline_ms, ACT_DEFAULT_MS, ACT_MAX_MS);
    const end = clock.now() + ms;
    let listed: DevTarget[];
    try {
      listed = await within(
        listTargets(connection.port, {
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          signal: AbortSignal.timeout(ms),
        }),
        ms,
        clock,
        "listing the app's windows",
      );
    } catch (error) {
      if (error instanceof DevAppToolError) throw error;
      throw new DevAppToolError(
        "endpoint_refused",
        `the app's window list did not answer on port ${connection.port} (${message(error)})`,
      );
    }
    const all = listed
      .filter((target) => isAppWindowTarget(target) && target.id !== undefined)
      .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    const current = connection.session.target.id;
    const list = all
      .map(
        (target) =>
          `${windowId(target)} ${windowLabel(target)}${target.id === current ? " [current]" : ""}`,
      )
      .join("\n");
    if (args.window === undefined) {
      if (all.length === 0) return "No app windows are open.";
      return `App windows (${all.length}):\n${list}\n\nNext: call window with window set to an id to switch.`;
    }
    const target = all.find((candidate) => windowId(candidate) === args.window);
    if (!target) {
      throw new DevAppToolError(
        "invalid_input",
        `no window ${JSON.stringify(args.window)}; open windows:\n${list || "none"}\n`,
        "call window without window to list the ids again",
      );
    }
    const left = (): number => Math.max(100, end - clock.now());
    if (target.id === current && connection.session.client.goneReason === null) {
      return firstSnapshot(connection, `Already on ${windowLabel(target)}.`, clock, left());
    }
    const client = await within(
      guardedConnect(connection.port)(target.webSocketDebuggerUrl),
      left(),
      clock,
      "connecting to the window",
    );
    const previous = connection.session;
    const session: DevAppSession = {
      ...previous,
      target,
      client,
      stop: async () => {
        client.close();
        await previous.stop();
      },
      stopNow: () => {
        client.close();
        previous.stopNow();
      },
    };
    previous.client.close();
    const next: DevAppConnection = { port: connection.port, session, generation: null };
    manager.set(next);
    return firstSnapshot(
      next,
      `Switched to ${windowLabel(target)} (${windowId(target)}). Refs from the previous window no longer work.`,
      clock,
      left(),
    );
  }

  async function close(): Promise<string> {
    const connection = manager.current;
    if (!connection && manager.launching) {
      try {
        await manager.replace(undefined);
      } catch (error) {
        return `Stopping the dev app that was still starting failed: ${message(error)}`;
      }
      return "Stopped the dev app this session was still starting.";
    }
    if (!connection) return "No dev app connection is open.";
    try {
      await manager.replace(undefined);
    } catch (error) {
      return `Closed the connection, but stopping the dev app failed: ${message(error)}`;
    }
    return connection.session.owned
      ? "Closed the connection and stopped the dev app this session launched."
      : "Closed the connection. The dev app keeps running (this session did not start it).";
  }

  async function run(
    args: DevAppArgs,
    context: ToolContext,
  ): Promise<string | StructuredToolResult> {
    const clock = abortableClock(baseClock, context.signal);
    switch (args.action) {
      case "open":
        if (args.mode === "launch") {
          if (isPlanModeActive(planModeRef)) return planModeRestriction("dev_app launch");
          return launch(args, clock, context.signal);
        }
        if (args.mode === "attach") return attach(args, clock, context.signal);
        throw new DevAppToolError("invalid_input", 'open needs mode "attach" or "launch"');
      case "snapshot": {
        const connection = requireConnection();
        const ms = budget(args.deadline_ms, ACT_DEFAULT_MS, ACT_MAX_MS);
        const end = clock.now() + ms;
        const text = args.expect
          ? await waitThenSnapshot(connection, args.expect, args.pane ?? null, ms, clock)
          : await snapshot(connection, args.pane ?? null, ms, clock);
        if (!args.screenshot) return text;
        const left = end - clock.now();
        if (left <= 0)
          throw new DevAppToolError(
            "timed_out",
            `no time was left for the screenshot within ${ms} ms`,
          );
        return screenshotResult(connection, text, left, clock);
      }
      case "act":
        if (isPlanModeActive(planModeRef)) return planModeRestriction("dev_app act");
        return act(args, clock);
      case "window":
        return windows(args, clock);
      case "close":
        return close();
    }
  }

  return {
    name: "dev_app",
    description:
      "Drive the running GG desktop dev app (Tauri + Vite on :1420). GG desktop dev app only; use " +
      "screenshot for other URLs. open: attach to the control port the user gave, or launch it " +
      "(Windows, isolated profile). snapshot: pane state plus visible interactive elements with refs " +
      "like e7 (screenshot:true adds a PNG; expect waits until it holds first, without acting). act: type, press, click a ref, " +
      "send_prompt, scroll (a wheel step, or a ref into view) or select (a dropdown option); each " +
      "returns confirmed/contradicted/unreadable and what changed (expect is inferred when omitted). " +
      "window: list the app's windows (What's new, extra project windows) or switch to one. " +
      "close stops only an app this session launched. One connection per session. A launch that " +
      "is not ready within its call keeps starting in the background; call open launch again to keep waiting. " +
      'open launch with provider "fake" answers prompts with canned replies, for chat flows without a login.',
    parameters: DevAppParams,
    executionMode: "sequential",
    // Above the longest launch call, so the loop never cuts a call off mid-wait.
    timeoutMs: LAUNCH_MAX_MS + 60_000,
    async execute(args: DevAppArgs, context: ToolContext) {
      try {
        const result = await run(args, context);
        if (typeof result === "string") return scrub(result);
        return result;
      } catch (error) {
        if (
          context.signal.aborted &&
          !(error instanceof DevAppToolError && error.code === "aborted")
        ) {
          throw new DevAppToolError("aborted", scrub(`the call was cancelled (${message(error)})`));
        }
        if (error instanceof DevAppToolError) {
          error.message = scrub(error.message);
          throw error;
        }
        throw new Error(scrub(message(error)), { cause: error });
      }
    },
  };
}
