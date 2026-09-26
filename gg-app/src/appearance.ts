// UI-only preferences, scoped to this origin/profile. Never session/project data.
export const APPEARANCE_STORAGE_KEY = "gg-app:appearance:v1";
export const APPEARANCE_MAX_BYTES = 2048;
const choices = {
  theme: ["dark", "light"],
  size: ["15", "16"],
  tracking: ["current", "normal"],
  paragraphs: ["current", "roomy"],
  cap: ["off", "on"],
  markers: ["off", "on"],
  streaming: ["current", "crisp"],
} as const;
export type Appearance = { [K in keyof typeof choices]: (typeof choices)[K][number] };
export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({
  theme: "dark",
  size: "15",
  tracking: "current",
  paragraphs: "current",
  cap: "off",
  markers: "off",
  streaming: "current",
});
const fields = Object.keys(choices) as (keyof Appearance)[];
export interface AppearanceSnapshot {
  readonly preferences: Readonly<Appearance>;
  readonly persistenceWarning: string | null;
}

export function parseAppearance(raw: string | null): Appearance {
  const result = { ...DEFAULT_APPEARANCE };
  if (!raw || raw.length > APPEARANCE_MAX_BYTES) return result;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const field of fields) {
      const candidate = Object.prototype.hasOwnProperty.call(value, field)
        ? (value as Record<string, unknown>)[field]
        : undefined;
      if (
        typeof candidate === "string" &&
        (choices[field] as readonly string[]).includes(candidate)
      ) {
        Object.assign(result, { [field]: candidate });
      }
    }
  } catch {
    /* Malformed records use defaults; never repair-write during loading. */
  }
  return result;
}

export function applyAppearance(root: HTMLElement, appearance: Readonly<Appearance>): void {
  for (const field of fields) root.setAttribute(`data-appearance-${field}`, appearance[field]);
  root.style.colorScheme = appearance.theme;
  root.style.setProperty("--reading-prose-size", `${appearance.size}px`);
}

export function createAppearanceOwner(host: Window, root: HTMLElement, transient = false) {
  const listeners = new Set<() => void>();
  const captures = new Set<() => () => void>();
  let turnRestores: (() => void)[] | undefined;
  let unsaved: Partial<Appearance> = {};
  let snapshot: AppearanceSnapshot = { preferences: DEFAULT_APPEARANCE, persistenceWarning: null };
  let stop: (() => void) | undefined;
  const read = (): Appearance => parseAppearance(host.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  const publish = (preferences: Appearance, persistenceWarning: string | null) => {
    const changed = fields.some((field) => preferences[field] !== snapshot.preferences[field]);
    if (!changed && persistenceWarning === snapshot.persistenceWarning) return;
    // Reuse pane view-state captures only for actual preference reflow, never
    // streaming tokens or persistence-warning changes. Restore before paint.
    if (changed && !transient && !turnRestores) {
      turnRestores = [...captures].map((capture) => capture());
      // Several synchronous preference changes are one reflow transaction.
      // Re-capturing between them can choose a newly exposed preceding line.
      queueMicrotask(() => {
        turnRestores = undefined;
      });
    }
    const restores = changed && !transient ? (turnRestores ?? []) : [];
    snapshot = Object.freeze({ preferences: Object.freeze(preferences), persistenceWarning });
    if (!transient) applyAppearance(root, preferences);
    restores.forEach((restore) => restore());
    listeners.forEach((listener) => listener());
  };
  const start = (): (() => void) => {
    if (stop) return stop;
    if (transient) return () => {};
    try {
      publish(read(), null);
    } catch {
      publish(
        { ...DEFAULT_APPEARANCE },
        "Appearance storage is unavailable. Changes apply only in this window.",
      );
    }
    applyAppearance(root, snapshot.preferences);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
      try {
        if (event.storageArea && event.storageArea !== host.localStorage) return;
      } catch {
        return;
      }
      // Removal/clear resets preferences. Never echo another window's write.
      unsaved = {};
      publish(parseAppearance(event.key === null ? null : event.newValue), null);
    };
    host.addEventListener("storage", onStorage);
    stop = () => {
      host.removeEventListener("storage", onStorage);
      stop = undefined;
    };
    return stop;
  };
  const update = (patch: Partial<Appearance>) => {
    const valid: Partial<Appearance> = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        const candidate = patch[field];
        if (
          typeof candidate === "string" &&
          (choices[field] as readonly string[]).includes(candidate)
        ) {
          Object.assign(valid, { [field]: candidate });
        }
      }
    }
    if (!Object.keys(valid).length) return;
    if (transient) {
      publish({ ...snapshot.preferences, ...valid }, null);
      return;
    }
    let latest = snapshot.preferences;
    try {
      latest = read();
    } catch {
      /* Keep the session choice if storage is denied. */
    }
    const next = { ...latest, ...unsaved, ...valid };
    let warning: string | null = null;
    try {
      host.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
      unsaved = {};
    } catch {
      unsaved = { ...unsaved, ...valid };
      warning = "Appearance could not be saved. Changes apply only in this window.";
    }
    publish(next, warning);
  };
  return {
    start,
    update,
    reset: () => update({ ...DEFAULT_APPEARANCE }),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    beforeApply: (capture: () => () => void) => {
      captures.add(capture);
      return () => {
        captures.delete(capture);
      };
    },
  };
}

// Preview comparisons have their own temporary owner and must neither read nor
// write saved preferences. The normal and What's New entries share this owner.
export const appearance = createAppearanceOwner(
  window,
  document.documentElement,
  import.meta.env.DEV && window.location.pathname === "/__chat-design-preview",
);
