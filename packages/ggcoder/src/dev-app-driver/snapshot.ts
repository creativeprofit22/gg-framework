import {
  describePageState,
  paneElementScript,
  type PageState,
  type PaneSelector,
} from "./observe.js";

export const SNAPSHOT_LIMITS = { elements: 150, lineChars: 120, totalBytes: 8192, nameChars: 60 };

/** Where in-page refs live; on `document`, so a reload drops every ref. */
const REGISTRY_KEY = "gg.devApp.refs";

export interface SnapshotElement {
  /** Present only on registering snapshots (refs are what `act` targets). */
  ref: string | null;
  role: string;
  name: string;
  /** Field text; never set for password or hidden inputs. */
  value: string | null;
  flags: string[];
}

export interface UiSnapshot {
  generation: number;
  /** Visible interactive elements in scope, including ones past the element limit. */
  total: number;
  /** Visible interactive elements behind an open modal (not listed). */
  hiddenBackground: number;
  modal: boolean;
  elements: SnapshotElement[];
}

export interface SnapshotScriptOptions {
  pane?: PaneSelector;
  /** Assign refs and replace the in-page registry (false for read-only change probes). */
  register?: boolean;
  limit?: number;
}

/** In-page expression listing visible interactive elements, scoped to an open modal if any. */
export function snapshotScript({
  pane = null,
  register = true,
  limit = SNAPSHOT_LIMITS.elements,
}: SnapshotScriptOptions = {}): string {
  return `(() => {
    const opts = ${JSON.stringify({ pane, register, limit, nameChars: SNAPSHOT_LIMITS.nameChars })};
    const KEY = Symbol.for(${JSON.stringify(REGISTRY_KEY)});
    const root = opts.pane === null ? document : ${paneElementScript(pane)};
    if (!root) return { problem: 'pane not found' };
    const SELECTOR = 'button, a[href], input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"], [role="combobox"], [tabindex]:not([tabindex^="-"])';
    const vw = typeof innerWidth === 'number' ? innerWidth : 0;
    const vh = typeof innerHeight === 'number' ? innerHeight : 0;
    const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);
    const escapeId = (id) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\\\]/g, '\\\\$&'));
    const tagOf = (el) => el.tagName.toLowerCase();
    const inputType = (el) => (el.getAttribute('type') || 'text').toLowerCase();
    const editable = (el) => el.isContentEditable === true || el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true';
    const isField = (el) => ['input', 'textarea', 'select'].includes(tagOf(el)) || editable(el);
    const visible = (el) => {
      if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const roleOf = (el) => {
      const explicit = clean(el.getAttribute('role')).split(' ')[0];
      if (explicit) return explicit;
      const tag = tagOf(el);
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = inputType(el);
        if (t === 'checkbox' || t === 'radio') return t;
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'range') return 'slider';
        return 'textbox';
      }
      if (editable(el)) return 'textbox';
      return tag;
    };
    const textOf = (id) => { const n = document.getElementById(id); return n ? n.textContent : ''; };
    const nameOf = (el) => {
      const aria = clean(el.getAttribute('aria-label'));
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by) { const t = clean(by.split(/\\s+/).map(textOf).join(' ')); if (t) return t; }
      const labels = el.labels ? [...el.labels] : [];
      if (labels.length === 0 && el.id) labels.push(...document.querySelectorAll('label[for="' + escapeId(el.id) + '"]'));
      const wrap = el.closest('label');
      if (wrap && !labels.includes(wrap)) labels.push(wrap);
      const fromLabels = clean(labels.map((l) => l.textContent).join(' '));
      if (fromLabels) return fromLabels;
      // innerText keeps the break between block children ("/init Generate…", not "/initGenerate…").
      if (!isField(el)) { const t = clean(typeof el.innerText === 'string' && el.innerText ? el.innerText : el.textContent); if (t) return t; }
      return clean(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '');
    };
    const valueOf = (el) => {
      const tag = tagOf(el);
      if (tag === 'input') {
        if (['password', 'hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(inputType(el))) return null;
        return String(el.value == null ? '' : el.value);
      }
      if (tag === 'textarea') return String(el.value == null ? '' : el.value);
      if (tag === 'select') {
        const o = (el.selectedOptions && el.selectedOptions[0]) || el.querySelector('option[selected]') || el.querySelector('option');
        return o ? clean(o.textContent) : null;
      }
      return null;
    };
    const flagsOf = (el) => {
      const f = [];
      if (el.disabled === true || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') f.push('disabled');
      const checked = el.getAttribute('aria-checked') === 'true' || (typeof el.checked === 'boolean' ? el.checked : tagOf(el) === 'input' && el.hasAttribute('checked'));
      if (checked) f.push('checked');
      if (el.getAttribute('aria-expanded') === 'true') f.push('expanded');
      if (el.getAttribute('aria-selected') === 'true' || el.selected === true) f.push('selected');
      if (document.activeElement === el) {
        f.push('focused');
        // Selection keys (ctrl+a, shift+arrows) change nothing else a snapshot can see.
        let start = null, end = null;
        try { start = el.selectionStart; end = el.selectionEnd; } catch { start = null; }
        const length = typeof el.value === 'string' ? el.value.length : 0;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          f.push(start === 0 && end === length ? 'all text selected' : (end - start) + ' chars selected');
        }
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= vw || y >= vh) f.push('offscreen');
      else if (typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== el && !el.contains(hit))) f.push('covered');
      }
      return f;
    };
    const modals = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')].filter(visible);
    const modal = modals.length > 0 ? modals[modals.length - 1] : null;
    const inScope = [...(modal || root).querySelectorAll(SELECTOR)].filter(visible);
    const hiddenBackground = modal ? [...root.querySelectorAll(SELECTOR)].filter((el) => !modal.contains(el) && visible(el)).length : 0;
    let reg = document[KEY];
    if (opts.register) {
      if (!reg) {
        reg = { generation: 0, next: 1, ids: new WeakMap(), current: new Map() };
        Object.defineProperty(document, KEY, { value: reg, configurable: true });
      }
      reg.generation += 1;
      reg.current = new Map();
    }
    const elements = inScope.slice(0, opts.limit).map((el) => {
      const value = valueOf(el);
      const item = { ref: null, role: roleOf(el), name: clip(nameOf(el), opts.nameChars), value: value === null ? null : clip(value, 40), flags: flagsOf(el) };
      if (opts.register) {
        let id = reg.ids.get(el);
        if (!id) { id = 'e' + reg.next++; reg.ids.set(el, id); }
        reg.current.set(id, el);
        item.ref = id;
      }
      return item;
    });
    return { generation: reg ? reg.generation : 0, total: inScope.length, hiddenBackground, modal: Boolean(modal), elements };
  })()`;
}

const REF = /^e[1-9]\d{0,6}$/;

export function isRef(value: string): boolean {
  return REF.test(value);
}

/**
 * In-page expression yielding the element behind `ref`, or `{ problem, block: "stale" }`
 * when the ref is not from the latest snapshot, the page reloaded, or the element left the page.
 */
export function refLocatorScript(ref: string, generation: number): string {
  if (!isRef(ref)) throw new RangeError(`invalid element ref: ${JSON.stringify(ref)}`);
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    const reg = document[Symbol.for(${JSON.stringify(REGISTRY_KEY)})];
    if (!reg) return { problem: ref + ' is from before the page reloaded', block: 'stale' };
    if (reg.generation !== ${generation}) return { problem: ref + ' is from an older snapshot', block: 'stale' };
    const el = reg.current.get(ref);
    if (!el) return { problem: ref + ' is not in the latest snapshot', block: 'stale' };
    if (!el.isConnected) return { problem: ref + ' is no longer on the page', block: 'stale' };
    return el;
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseElement(value: unknown): SnapshotElement | null {
  if (!isRecord(value)) return null;
  const { ref, role, name, value: fieldValue, flags } = value;
  if (
    (ref !== null && typeof ref !== "string") ||
    typeof role !== "string" ||
    typeof name !== "string" ||
    (fieldValue !== null && typeof fieldValue !== "string") ||
    !Array.isArray(flags) ||
    !flags.every((flag) => typeof flag === "string")
  )
    return null;
  return { ref, role, name, value: fieldValue, flags: flags as string[] };
}

/** Validates a snapshot answer; a `problem` answer or bad shape yields an error string. */
export function parseSnapshot(value: unknown): UiSnapshot | string {
  if (!isRecord(value)) return "snapshot had an unexpected shape";
  if (typeof value.problem === "string") return value.problem;
  const { generation, total, hiddenBackground, modal, elements } = value;
  if (
    typeof generation !== "number" ||
    typeof total !== "number" ||
    typeof hiddenBackground !== "number" ||
    typeof modal !== "boolean" ||
    !Array.isArray(elements)
  )
    return "snapshot had an unexpected shape";
  const parsed: SnapshotElement[] = [];
  for (const entry of elements) {
    const element = parseElement(entry);
    if (!element) return "snapshot had an unexpected shape";
    parsed.push(element);
  }
  return { generation, total, hiddenBackground, modal, elements: parsed };
}

function clipLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One element without its ref, as used for change summaries. */
export function describeElement(element: SnapshotElement): string {
  const name = element.name ? ` ${JSON.stringify(element.name)}` : "";
  const value = element.value !== null ? ` value=${JSON.stringify(element.value)}` : "";
  const flags = element.flags.length > 0 ? ` [${element.flags.join(", ")}]` : "";
  return clipLine(`${element.role}${name}${value}${flags}`, SNAPSHOT_LIMITS.lineChars);
}

export function formatElement(element: SnapshotElement): string {
  const line = describeElement(element);
  return clipLine(element.ref ? `${element.ref} ${line}` : line, SNAPSHOT_LIMITS.lineChars);
}

/** Compact text view: a page-state header, then one line per element, capped in size. */
export function formatSnapshot(page: PageState, snapshot: UiSnapshot): string {
  const pane = page.paneId ? `pane ${page.paneId}: ` : "";
  const lines = [
    clipLine(`Snapshot ${snapshot.generation} · ${pane}${describePageState(page)}`, 240),
  ];
  if (snapshot.modal) {
    lines.push(
      `Dialog open: listing only its items (${snapshot.hiddenBackground} background items hidden).`,
    );
  }
  if (snapshot.total === 0) lines.push("No visible interactive elements.");
  let used = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  let shown = 0;
  const reserve = 64;
  for (const element of snapshot.elements) {
    const line = formatElement(element);
    const size = Buffer.byteLength(line) + 1;
    if (used + size + reserve > SNAPSHOT_LIMITS.totalBytes) break;
    lines.push(line);
    used += size;
    shown += 1;
  }
  const hidden = snapshot.total - shown;
  if (hidden > 0) lines.push(`${hidden} more not shown.`);
  return lines.join("\n");
}
