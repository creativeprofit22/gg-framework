import { parseHTML } from "linkedom";
import type { ControlClient } from "../dev-app-driver/control-client.js";
import type { SentInput } from "./dev-app-driver-fakes.js";

/**
 * A linkedom page with just enough layout for the dev-app scripts: `data-rect="x,y,w,h"` gives an
 * element its box, `data-z` stacks it, and focus/activeElement/elementFromPoint follow from those.
 */
export interface FixturePage {
  window: Window & typeof globalThis;
  document: Document;
  width: number;
  height: number;
  evaluate(expression: string): unknown;
  focus(element: Element | null): void;
  find(selector: string): HTMLElement;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectOf(element: Element): Rect | null {
  const raw = element.getAttribute("data-rect");
  if (!raw) return null;
  const [x = 0, y = 0, width = 0, height = 0] = raw.split(",").map(Number);
  return { x, y, width, height };
}

function hiddenByAncestor(element: Element): boolean {
  return element.closest('[hidden], [aria-hidden="true"], [inert]') !== null;
}

function zOf(element: Element): number {
  const host = element.closest("[data-z]");
  return host ? Number(host.getAttribute("data-z")) : 0;
}

export function createFixturePage(html: string, { width = 1280, height = 800 } = {}): FixturePage {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  let active: Element | null = null;
  // Per-instance overrides keep the shared linkedom prototypes untouched.
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (active && active.isConnected ? active : document.body),
  });
  const focusable = (element: Element): boolean =>
    !element.hasAttribute("disabled") &&
    element.matches("button, a[href], input, textarea, select, [contenteditable], [tabindex]");
  const patchFocus = (element: Element): void => {
    Object.defineProperty(element, "focus", {
      configurable: true,
      value: () => {
        if (focusable(element)) active = element;
      },
    });
  };
  for (const element of document.querySelectorAll("*")) patchFocus(element);
  // Elements added later (fixture mutations) get focus() through this hook.
  const createElement = document.createElement.bind(document);
  Object.defineProperty(document, "createElement", {
    configurable: true,
    value: (tag: string) => {
      const element = createElement(tag);
      patchFocus(element);
      return element;
    },
  });
  const boxOf = (element: Element): DOMRect => {
    const rect = rectOf(element) ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      ...rect,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect,
    };
  };
  const patchBox = (element: Element): void => {
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => boxOf(element),
    });
  };
  for (const element of document.querySelectorAll("*")) patchBox(element);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number): Element | null => {
      let best: Element | null = null;
      let bestZ = Number.NEGATIVE_INFINITY;
      for (const element of document.querySelectorAll("[data-rect]")) {
        const rect = rectOf(element);
        if (!rect || hiddenByAncestor(element)) continue;
        if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height)
          continue;
        const z = zOf(element);
        if (z >= bestZ) {
          best = element;
          bestZ = z;
        }
      }
      return best;
    },
  });
  const getComputedStyle = (element: Element) => {
    const style = element.getAttribute("style") ?? "";
    return {
      display: /display:\s*none/.test(style) ? "none" : "block",
      visibility: /visibility:\s*hidden/.test(style) ? "hidden" : "visible",
    };
  };
  const css = { escape: (value: string) => value.replace(/["\\]/g, "\\$&") };

  const page: FixturePage = {
    window,
    document,
    width,
    height,
    evaluate(expression) {
      // New elements from fixture mutations need the layout and focus shims too.
      for (const element of document.querySelectorAll("*")) {
        if (!Object.prototype.hasOwnProperty.call(element, "getBoundingClientRect")) {
          patchBox(element);
          patchFocus(element);
        }
      }
      const run = new Function(
        "document",
        "window",
        "innerWidth",
        "innerHeight",
        "getComputedStyle",
        "CSS",
        `return (${expression});`,
      ) as (...args: unknown[]) => unknown;
      return run(document, window, width, height, getComputedStyle, css);
    },
    focus(element) {
      active = element;
    },
    find(selector) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`fixture has no ${selector}`);
      return element as HTMLElement;
    },
  };
  return page;
}

/** Sets a field's text the way linkedom stores it (textarea text lives in its content). */
export function setFieldValue(element: Element, value: string): void {
  if (element.tagName === "TEXTAREA") element.textContent = value;
  else element.setAttribute("value", value);
}

export function fieldValue(element: Element): string {
  return element.tagName === "TEXTAREA"
    ? (element.textContent ?? "")
    : (element.getAttribute("value") ?? "");
}

/** A control client whose reads run against a fixture page and whose inputs edit it. */
export class DomControlClient implements ControlClient {
  readonly page: FixturePage;
  sent: SentInput[] = [];
  goneReason: string | null = null;
  closed = false;
  readonly whenGone: Promise<string>;
  /** App behaviour for a key press (after Input.dispatchKeyEvent keyDown). */
  onKey: (key: string, modifiers: number) => void = () => {};
  /** App behaviour for a click on the element under the pointer. */
  onClick: (element: Element) => void = () => {};
  /** Runs before every read or script; lets a test stall or detach the page. */
  beforeEvaluate: ((expression: string) => Promise<void> | void) | null = null;
  screenshot = Buffer.from("fake-png").toString("base64");
  private markGone: (reason: string) => void = () => {};

  constructor(page: FixturePage) {
    this.page = page;
    this.whenGone = new Promise((resolve) => {
      this.markGone = resolve;
    });
  }

  gone(reason = "dev fixture debugging target detached"): void {
    this.goneReason = reason;
    this.markGone(reason);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.goneReason) throw new Error(this.goneReason);
    this.sent.push({ method, params });
    const { document } = this.page;
    if (method === "Input.insertText") {
      const target = document.activeElement;
      if (target && target !== document.body) {
        setFieldValue(target, fieldValue(target) + String(params.text));
      }
    } else if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
      this.onKey(String(params.key), Number(params.modifiers ?? 0));
    } else if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      const hit = (
        document as Document & { elementFromPoint(x: number, y: number): Element | null }
      ).elementFromPoint(Number(params.x), Number(params.y));
      if (hit) this.onClick(hit);
    } else if (method === "Page.captureScreenshot") {
      return { data: this.screenshot };
    }
    return {};
  }

  async evaluate(expression: string): Promise<unknown> {
    if (this.goneReason) throw new Error(this.goneReason);
    await this.beforeEvaluate?.(expression);
    if (this.goneReason) throw new Error(this.goneReason);
    return this.page.evaluate(expression);
  }

  close(): void {
    this.closed = true;
  }

  inputs(method: string): SentInput[] {
    return this.sent.filter((entry) => entry.method === method);
  }
}

/** A one-pane app shell with the classes observeScript reads; `extra` lands after the pane. */
export function appShellHtml({
  pane = "",
  extra = "",
  status = "Ready",
}: { pane?: string; extra?: string; status?: string } = {}): string {
  return `<div data-pane-id="pane-a" data-rect="0,0,640,800"><div class="agent-pane pane-focused" data-rect="0,0,640,800">
  <div class="statusrow-state">${status}</div>
  ${pane}
  <textarea class="input" aria-label="Message" data-rect="10,700,500,40"></textarea>
  <button class="send" aria-label="Send" data-rect="520,700,80,40">Send</button>
</div></div>${extra}`;
}
