export interface FocusedElement {
  tag: string;
  paneId: string | null;
  label: string;
}

/** One read of the page as the user would see it, scoped to one agent pane. */
export interface PageState {
  paneFound: boolean;
  paneId: string | null;
  draft: string | null;
  composerDisabled: boolean | null;
  menuOpen: boolean;
  modalOpen: boolean;
  status: string | null;
  phase: string | null;
  queued: number;
  focused: FocusedElement | null;
}

/** `null` = the focused agent pane (or the only one); otherwise a workspace `data-pane-id`. */
export type PaneSelector = string | null;

/** In-page expression that evaluates to the pane root element or null. */
export function paneElementScript(pane: PaneSelector = null): string {
  return `(() => {
    const paneId = ${JSON.stringify(pane)};
    if (paneId !== null) {
      const host = document.querySelector('[data-pane-id="' + CSS.escape(paneId) + '"]');
      if (!host) return null;
      return host.matches('.agent-pane') ? host : host.querySelector('.agent-pane');
    }
    const panes = [...document.querySelectorAll('.agent-pane')];
    return panes.find((p) => p.classList.contains('pane-focused')) ?? (panes.length === 1 ? panes[0] : null);
  })()`;
}

export function observeScript(pane: PaneSelector = null): string {
  return `(() => {
    const pane = ${paneElementScript(pane)};
    const input = pane ? pane.querySelector('textarea.input') : null;
    const statusEl = pane ? pane.querySelector('.statusrow-state') : null;
    const statusText = statusEl ? (statusEl.textContent || '').split('\\u00b7')[0].trim() : '';
    const queueBar = pane ? pane.querySelector('.queued-bar.chat-queue:not(.leaving)') : null;
    let queued = 0;
    if (queueBar) {
      const many = /^(\\d+) messages/.exec((queueBar.querySelector('.queued-bar-text')?.textContent || '').trim());
      queued = many ? Number(many[1]) : Math.max(1, queueBar.querySelectorAll('.queued-list-item').length);
    }
    const active = document.activeElement;
    const focused = active && active !== document.body ? {
      tag: active.tagName.toLowerCase(),
      paneId: active.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
      label: (active.getAttribute('aria-label') || (active.matches('textarea, input') ? '' : active.textContent) || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    } : null;
    return {
      paneFound: Boolean(pane),
      paneId: pane?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
      draft: input ? input.value : null,
      composerDisabled: input ? input.disabled : null,
      menuOpen: Boolean(pane?.querySelector('.slash-menu')) || input?.getAttribute('data-slash-menu-open') === 'true',
      modalOpen: Boolean(document.querySelector('[aria-modal="true"]')),
      status: statusText || null,
      phase: pane?.querySelector('.task-activity')?.getAttribute('data-phase') ?? null,
      queued,
      focused,
    };
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const stringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function parseFocused(value: unknown): FocusedElement | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { tag, paneId, label } = value;
  if (typeof tag !== "string" || !stringOrNull(paneId) || typeof label !== "string")
    return undefined;
  return { tag, paneId, label };
}

/** Validates the page's answer; `null` means the read is unusable. */
export function parsePageState(value: unknown): PageState | null {
  if (!isRecord(value)) return null;
  const { paneFound, paneId, draft, composerDisabled, menuOpen, modalOpen, status, phase, queued } =
    value;
  const focused = parseFocused(value.focused);
  if (
    typeof paneFound !== "boolean" ||
    !stringOrNull(paneId) ||
    !stringOrNull(draft) ||
    (composerDisabled !== null && typeof composerDisabled !== "boolean") ||
    typeof menuOpen !== "boolean" ||
    typeof modalOpen !== "boolean" ||
    !stringOrNull(status) ||
    !stringOrNull(phase) ||
    typeof queued !== "number" ||
    !Number.isFinite(queued) ||
    focused === undefined
  )
    return null;
  return {
    paneFound,
    paneId,
    draft,
    composerDisabled,
    menuOpen,
    modalOpen,
    status,
    phase,
    queued,
    focused,
  };
}

function quote(text: string | null): string {
  if (text === null) return "none";
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}

export function describePageState(state: PageState): string {
  if (!state.paneFound) return "pane not found";
  const focus = state.focused
    ? `${state.focused.tag}${state.focused.label ? ` "${state.focused.label}"` : ""}`
    : "nothing";
  return [
    `draft ${quote(state.draft)}`,
    `menu ${state.menuOpen ? "open" : "closed"}`,
    `status ${state.status ?? "none"}`,
    ...(state.queued > 0 ? [`${state.queued} queued`] : []),
    ...(state.modalOpen ? ["dialog open"] : []),
    `focus ${focus}`,
  ].join(", ");
}

export { quote as quoteDraft };
