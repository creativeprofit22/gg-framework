/**
 * The composer's action button: which options its dial offers, which one the
 * button currently shows, and where each option sits around the hub.
 *
 * Adding an option: add its id to COMPOSER_ACTION_IDS and its label below, then
 * add its entry to `composerActionOptions` in AgentPane; `satisfies
 * Record<ComposerActionId, …>` there makes a missing one a type error.
 */

export const COMPOSER_ACTION_IDS = ["opportunities", "post-check"] as const;
export type ComposerActionId = (typeof COMPOSER_ACTION_IDS)[number];

export const COMPOSER_ACTION_LABELS = {
  opportunities: "Opportunities",
  "post-check": "Post-check",
} as const satisfies Record<ComposerActionId, string>;

/** Post-check's commands, sent in this order. Each waits for the one before it. */
export const POST_CHECK_SEQUENCE = ["/trace", "/parity", "/contract"] as const;

export const DEFAULT_COMPOSER_ACTION: ComposerActionId = "opportunities";
export const COMPOSER_ACTION_STORAGE_KEY = "gg-composer-action";

export function isComposerActionId(value: unknown): value is ComposerActionId {
  return typeof value === "string" && (COMPOSER_ACTION_IDS as readonly string[]).includes(value);
}

/** The option the button showed last time, or the default when unset or unreadable. */
export function readComposerAction(storage: Pick<Storage, "getItem"> | null): ComposerActionId {
  try {
    const stored = storage?.getItem(COMPOSER_ACTION_STORAGE_KEY);
    return isComposerActionId(stored) ? stored : DEFAULT_COMPOSER_ACTION;
  } catch {
    return DEFAULT_COMPOSER_ACTION;
  }
}

export function writeComposerAction(
  storage: Pick<Storage, "setItem"> | null,
  id: ComposerActionId,
): void {
  try {
    storage?.setItem(COMPOSER_ACTION_STORAGE_KEY, id);
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
}

/** Composer commands that `available` lacks, in sequence order. */
export function missingSequenceCommands(
  sequence: readonly string[],
  available: readonly { name: string; aliases: readonly string[] }[],
): string[] {
  const names = new Set(
    available.flatMap((command) => [command.name, ...command.aliases].map((n) => n.toLowerCase())),
  );
  return sequence.filter((command) => !names.has(command.slice(1).toLowerCase()));
}

export interface DialPoint {
  /** Offset from the hub's centre, in CSS px (y grows downward). */
  x: number;
  y: number;
}

/** Radius every petal's centre sits at, for up to three options. */
export const DIAL_RADIUS = 64;

/**
 * Petal positions for `count` options, fanned over the top of the hub (the
 * composer sits at the bottom of the pane, so the dial opens upward). Up to 60°
 * apart, never wider than a 150° arc; four or more options also push outward
 * so neighbours keep their spacing.
 */
export function dialLayout(count: number): DialPoint[] {
  if (count <= 0) return [];
  const step = count === 1 ? 0 : Math.min(60, 150 / (count - 1));
  const radius = DIAL_RADIUS + Math.max(0, count - 3) * 10;
  return Array.from({ length: count }, (_, index) => {
    const degrees = -90 + (index - (count - 1) / 2) * step;
    const radians = (degrees * Math.PI) / 180;
    return {
      x: Math.round(Math.cos(radians) * radius * 10) / 10,
      y: Math.round(Math.sin(radians) * radius * 10) / 10,
    };
  });
}

/**
 * Horizontal nudge that keeps every petal (plus `margin`) inside
 * `[boundsLeft, boundsRight]` when the hub sits near an edge. 0 when it fits.
 */
export function dialShift(
  centre: number,
  points: readonly DialPoint[],
  boundsLeft: number,
  boundsRight: number,
  margin: number,
): number {
  if (points.length === 0) return 0;
  const left = centre + Math.min(...points.map((p) => p.x)) - margin;
  const right = centre + Math.max(...points.map((p) => p.x)) + margin;
  if (right - left > boundsRight - boundsLeft) return 0;
  if (left < boundsLeft) return boundsLeft - left;
  if (right > boundsRight) return boundsRight - right;
  return 0;
}
