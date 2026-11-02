import { assertDeadline, systemClock, type DriverClock } from "./clock.js";
import type { ControlClient } from "./control-client.js";
import {
  promptStarted,
  typedIntoEmptyComposer,
  type Expectation,
  type Observation,
} from "./expectations.js";
import {
  insertText,
  MODIFIERS,
  pointerMove,
  pointerPress,
  pointerRelease,
  pressKey,
} from "./input.js";
import type { Point } from "./input.js";
import {
  describePageState,
  observeScript,
  paneElementScript,
  parsePageState,
  type PageState,
  type PaneSelector,
} from "./observe.js";

export type Verdict = "confirmed" | "contradicted" | "unreadable";

/** Why a pre-check refused to send input. */
export type BlockReason =
  "missing" | "stale" | "disabled" | "covered" | "offscreen" | "unfocusable";

const BLOCK_REASONS: ReadonlySet<string> = new Set([
  "missing",
  "stale",
  "disabled",
  "covered",
  "offscreen",
  "unfocusable",
]);

export interface ActionOutcome {
  verdict: Verdict;
  action: string;
  expectation: string;
  reason: string;
  /** Whether anything observable differed from the starting state. */
  changed: boolean;
  baseline: Observation | null;
  observed: Observation | null;
  elapsedMs: number;
  /** Set when a pre-check refused to send anything. */
  blockedBy?: BlockReason;
}

function formatOutcome(outcome: ActionOutcome): string {
  const seen = outcome.observed ?? outcome.baseline;
  const page = seen ? `; saw ${describePageState(seen.page)}` : "";
  return `${outcome.action} ${outcome.verdict} (${outcome.expectation}): ${outcome.reason}${page}`.slice(
    0,
    600,
  );
}

export class DevAppActionError extends Error {
  override name = "DevAppActionError";
  readonly outcome: ActionOutcome;
  constructor(outcome: ActionOutcome) {
    super(formatOutcome(outcome));
    this.outcome = outcome;
  }
}

/** Thrown by an action's input step when a pre-check showed the input must not be sent. */
class NotSent extends Error {
  readonly block: BlockReason;
  constructor(message: string, block: BlockReason) {
    super(message);
    this.block = block;
  }
}

function blockOf(value: unknown, fallback: BlockReason): BlockReason {
  return typeof value === "string" && BLOCK_REASONS.has(value) ? (value as BlockReason) : fallback;
}

/** In-page expression for one CSS selector that must match exactly one element. */
function selectorLocator(selector: string): string {
  return `(() => {
    const matches = document.querySelectorAll(${JSON.stringify(selector)});
    if (matches.length !== 1) return { problem: matches.length + ' elements match', block: 'missing' };
    return matches[0];
  })()`;
}

/** Shared in-page start for locator scripts: binds `el` or returns the locator's problem. */
function locate(locator: string): string {
  return `const found = ${locator};
    if (!found || typeof found !== 'object') return { problem: 'element not found', block: 'missing' };
    if (typeof found.problem === 'string') return found;
    const el = found;
    const disabled = el.disabled === true || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';`;
}

function focusScript(locator: string): string {
  return `(() => {
    ${locate(locator)}
    if (disabled) return { problem: 'element is disabled', block: 'disabled' };
    el.focus();
    return document.activeElement === el ? 'focused' : { problem: 'element did not take focus', block: 'unfocusable' };
  })()`;
}

function clickScript(locator: string): string {
  return `(() => {
    ${locate(locator)}
    if (disabled) return { problem: 'element is disabled', block: 'disabled' };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { problem: 'element has no size', block: 'offscreen' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { problem: 'element centre is outside the viewport', block: 'offscreen' };
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== el && !el.contains(hit))) {
      const label = hit ? (hit.getAttribute('aria-label') || hit.className || '').toString().trim().slice(0, 60) : '';
      return { problem: 'covered by ' + (hit ? hit.tagName.toLowerCase() + (label ? ' "' + label + '"' : '') : 'nothing'), block: 'covered' };
    }
    return { x, y };
  })()`;
}

export type ModifierName = keyof typeof MODIFIERS;

export interface ActionOptions {
  pane?: PaneSelector;
  deadlineMs?: number;
}

export interface CheckedActionOptions extends ActionOptions {
  expect: Expectation;
}

export interface DevAppDriverOptions {
  client: ControlClient;
  clock?: DriverClock;
  deadlineMs?: number;
  pollMs?: number;
}

export interface DevAppDriver {
  /** `into` is a CSS selector; `intoElement` an in-page locator expression (for example a ref). */
  type(
    text: string,
    options: CheckedActionOptions & { into?: string; intoElement?: string },
  ): Promise<ActionOutcome>;
  press(
    key: string,
    options: CheckedActionOptions & { modifiers?: number | readonly ModifierName[] },
  ): Promise<ActionOutcome>;
  click(selector: string, options: CheckedActionOptions): Promise<ActionOutcome>;
  /** Clicks the element an in-page locator expression yields (an Element or `{ problem, block }`). */
  clickElement(
    label: string,
    locator: string,
    options: CheckedActionOptions,
  ): Promise<ActionOutcome>;
  pointerDown(
    point: Point,
    options: CheckedActionOptions & { move?: boolean },
  ): Promise<ActionOutcome>;
  pointerUp(point: Point, options: CheckedActionOptions): Promise<ActionOutcome>;
  sendPrompt(text: string, options?: ActionOptions): Promise<ActionOutcome>;
  waitFor(label: string, expectation: Expectation, options?: ActionOptions): Promise<ActionOutcome>;
  observe(pane?: PaneSelector): Promise<PageState>;
}

type ReadResult =
  | { ok: true; observation: Observation }
  | { ok: false; reason: string; gone: boolean; outOfTime: boolean };

function modifierMask(modifiers: number | readonly ModifierName[] | undefined): number {
  if (modifiers === undefined) return 0;
  if (typeof modifiers === "number") {
    if (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) {
      throw new RangeError(`invalid modifier mask: ${modifiers}`);
    }
    return modifiers;
  }
  return modifiers.reduce((mask, name) => mask | MODIFIERS[name], 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readScript(pane: PaneSelector, probe: string | undefined): string {
  return `(async () => ({ page: ${observeScript(pane)}, probe: ${probe ? `await (async () => (${probe}))()` : "null"} }))()`;
}

export function createDevAppDriver({
  client,
  clock = systemClock,
  deadlineMs: defaultDeadlineMs = 5000,
  pollMs = 50,
}: DevAppDriverOptions): DevAppDriver {
  assertDeadline("deadlineMs", defaultDeadlineMs);
  assertDeadline("pollMs", pollMs);

  async function read(
    script: string,
    expectation: Expectation,
    remainingMs: number,
  ): Promise<ReadResult> {
    if (client.goneReason !== null) {
      return {
        ok: false,
        reason: `target gone: ${client.goneReason}`,
        gone: true,
        outOfTime: false,
      };
    }
    if (remainingMs <= 0)
      return { ok: false, reason: "deadline passed", gone: false, outOfTime: true };
    const stop = new AbortController();
    const evaluation = client.evaluate(script).then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const timeout = clock
      .sleep(remainingMs, stop.signal)
      .then(() => ({ kind: "timeout" as const }));
    const result = await Promise.race([evaluation, timeout]);
    stop.abort();
    if (result.kind === "timeout") {
      return {
        ok: false,
        reason: "page read did not answer before the deadline",
        gone: false,
        outOfTime: true,
      };
    }
    if (result.kind === "error") {
      const gone = client.goneReason !== null;
      return {
        ok: false,
        reason: gone
          ? `target gone: ${client.goneReason}`
          : `page read failed: ${message(result.error)}`,
        gone,
        outOfTime: false,
      };
    }
    const value = result.value;
    const record =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const page = parsePageState(record.page);
    if (!page)
      return {
        ok: false,
        reason: "page state had an unexpected shape",
        gone: false,
        outOfTime: false,
      };
    if (expectation.usesPane && !page.paneFound) {
      return {
        ok: false,
        reason: "target gone: the pane is not on the page",
        gone: true,
        outOfTime: false,
      };
    }
    return { ok: true, observation: { page, probe: record.probe ?? null } };
  }

  async function act(
    action: string,
    expectation: Expectation,
    options: ActionOptions,
    run: (() => Promise<void>) | null,
  ): Promise<ActionOutcome> {
    const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
    assertDeadline("deadlineMs", deadlineMs);
    const requireChange = run !== null && expectation.requireChange !== false;
    const started = clock.now();
    const deadline = started + deadlineMs;
    const script = readScript(options.pane ?? null, expectation.probe);
    let baseline: Observation | null = null;
    let observed: Observation | null = null;
    const finish = (verdict: Verdict, reason: string, blockedBy?: BlockReason): ActionOutcome => {
      const outcome: ActionOutcome = {
        verdict,
        action,
        expectation: expectation.label,
        reason,
        changed:
          baseline !== null &&
          observed !== null &&
          JSON.stringify(observed) !== JSON.stringify(baseline),
        baseline,
        observed,
        elapsedMs: clock.now() - started,
        ...(blockedBy ? { blockedBy } : {}),
      };
      if (verdict !== "confirmed") throw new DevAppActionError(outcome);
      return outcome;
    };

    const first = await read(script, expectation, deadline - clock.now());
    if (!first.ok)
      return finish(
        "unreadable",
        `could not read the starting state (${first.reason}); nothing was sent`,
      );
    baseline = first.observation;
    const before = expectation.judge(baseline, baseline);
    if (typeof before === "object") {
      return finish("contradicted", `${before.contradicted}; nothing was sent`);
    }
    if (before === "met") {
      if (requireChange)
        return finish("contradicted", "already true before acting; nothing was sent");
      // A no-change action still sends its input; the condition must hold afterwards.
      if (!run) {
        observed = baseline;
        return finish("confirmed", "condition holds");
      }
    }

    if (run) {
      try {
        await run();
      } catch (error) {
        if (error instanceof NotSent)
          return finish("contradicted", `${error.message}; nothing was sent`, error.block);
        const gone = client.goneReason !== null;
        return finish(
          "unreadable",
          gone ? `target gone: ${client.goneReason}` : `input could not be sent: ${message(error)}`,
        );
      }
    }

    for (;;) {
      const next = await read(script, expectation, deadline - clock.now());
      if (!next.ok) {
        if (next.gone) return finish("unreadable", next.reason);
        if (!next.outOfTime || observed === null) {
          return finish(
            "unreadable",
            next.outOfTime ? `${next.reason}; no state was read after acting` : next.reason,
          );
        }
        break;
      }
      observed = next.observation;
      const judgement = expectation.judge(observed, baseline);
      if (typeof judgement === "object") return finish("contradicted", judgement.contradicted);
      if (judgement === "met")
        return finish(
          "confirmed",
          requireChange ? "condition became true after acting" : "condition holds",
        );
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      await clock.sleep(Math.min(pollMs, remaining));
    }

    const changed = JSON.stringify(observed) !== JSON.stringify(baseline);
    const detail = expectation.describeTimeout?.(observed, baseline);
    return finish(
      "contradicted",
      `not met within ${deadlineMs} ms; ${detail ?? (changed ? "the page changed but the condition never held" : "nothing changed")}`,
    );
  }

  async function evaluateFlag(expression: string): Promise<unknown> {
    return client.evaluate(expression);
  }

  function clickElement(
    label: string,
    locator: string,
    { expect, ...options }: CheckedActionOptions,
  ): Promise<ActionOutcome> {
    return act(label, expect, options, async () => {
      const target = await evaluateFlag(clickScript(locator));
      const record = isRecord(target) ? target : {};
      if (typeof record.problem === "string") {
        throw new NotSent(record.problem, blockOf(record.block, "missing"));
      }
      const { x, y } = record;
      if (typeof x !== "number" || typeof y !== "number")
        throw new Error("could not measure the element");
      await pointerMove(client, { x, y });
      await pointerPress(client, { x, y });
      await pointerRelease(client, { x, y });
    });
  }

  return {
    type(text, { into, intoElement, expect, ...options }) {
      if (text.length === 0) throw new RangeError("type needs non-empty text");
      const locator = intoElement ?? (into !== undefined ? selectorLocator(into) : undefined);
      return act(`type ${JSON.stringify(text.slice(0, 40))}`, expect, options, async () => {
        if (locator !== undefined) {
          const focused = await evaluateFlag(focusScript(locator));
          if (focused !== "focused") {
            const record = isRecord(focused) ? focused : {};
            const problem = typeof record.problem === "string" ? record.problem : String(focused);
            throw new NotSent(
              `could not focus ${into ?? "the element"} (${problem})`,
              blockOf(record.block, "unfocusable"),
            );
          }
        }
        await insertText(client, text);
      });
    },
    press(key, { modifiers, expect, ...options }) {
      const mask = modifierMask(modifiers);
      return act(`press ${key}${mask ? ` (modifiers ${mask})` : ""}`, expect, options, () =>
        pressKey(client, key, mask),
      );
    },
    click(selector, options) {
      return clickElement(`click ${selector}`, selectorLocator(selector), options);
    },
    clickElement(label, locator, options) {
      return clickElement(label, locator, options);
    },
    pointerDown(point, { move = true, expect, ...options }) {
      return act(
        `pointer down at ${Math.round(point.x)},${Math.round(point.y)}`,
        expect,
        options,
        async () => {
          if (move) await pointerMove(client, point);
          await pointerPress(client, point);
        },
      );
    },
    pointerUp(point, { expect, ...options }) {
      return act(
        `pointer up at ${Math.round(point.x)},${Math.round(point.y)}`,
        expect,
        options,
        () => pointerRelease(client, point),
      );
    },
    async sendPrompt(text, options = {}) {
      if (text.trim().length === 0) throw new RangeError("sendPrompt needs non-empty text");
      const pane = options.pane ?? null;
      await act(`type prompt`, typedIntoEmptyComposer(text), options, async () => {
        const focused = await evaluateFlag(`(() => {
          const input = ${paneElementScript(pane)}?.querySelector('textarea.input');
          if (!input) return 'missing';
          input.focus();
          return document.activeElement === input ? 'focused' : 'not-focused';
        })()`);
        if (focused !== "focused")
          throw new NotSent(`could not focus the composer (${String(focused)})`, "unfocusable");
        await insertText(client, text);
      });
      return act(`send prompt`, promptStarted(), options, () => pressKey(client, "Enter"));
    },
    waitFor(label, expectation, options = {}) {
      return act(`wait for ${label}`, { ...expectation, requireChange: false }, options, null);
    },
    async observe(pane = null) {
      const result = await read(
        readScript(pane, undefined),
        { label: "observe", judge: () => "met" },
        defaultDeadlineMs,
      );
      if (!result.ok) throw new Error(`could not read the page: ${result.reason}`);
      return result.observation.page;
    },
  };
}
