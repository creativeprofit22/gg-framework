import { theme } from "./theme";
import {
  describeSchedule,
  parseScheduleCommand,
  scheduleSlotAtCaret,
  type ScheduleSlot,
} from "./scheduleCommand";

/**
 * Argument hint for `/schedule`, rendered in place of the command palette once
 * the user has typed past the command token.
 *
 * Reuses `.slash-menu` chrome so it shares the palette's anchor, surface, and
 * shadow — this reads as the same surface changing contents, not a second
 * popover appearing in the same corner.
 *
 * Two rows:
 *  1. The signature, with the slot the caret is in highlighted. This answers
 *     "what do I type next" without the user having to remember the grammar.
 *  2. Either a resolved summary ("Every 15 min · until stopped") or the parser's
 *     error with the offending text underlined. The resolved summary is the real
 *     validation: reading back "every 90 min" after typing `1h30m` is what
 *     catches a mistyped interval before it is ever scheduled.
 */

const SLOTS: { slot: ScheduleSlot; label: string; hint: string }[] = [
  { slot: "prompt", label: "<prompt>", hint: "what to run" },
  { slot: "every", label: "<every>", hint: "15m, 2h or 1h30m" },
  { slot: "times", label: "[times]", hint: "omit to run until stopped" },
];

/** Interval presets, offered as one-click fills for the slot users mistype most. */
export const INTERVAL_PRESETS = ["15m", "1h", "6h", "24h"] as const;

interface Props {
  /** Raw composer text, including the leading `/schedule`. */
  input: string;
  /** Caret offset into `input`, used to highlight the active slot. */
  caret: number;
  /** Fills the interval slot with a preset. */
  onPickInterval: (preset: string) => void;
}

export function ScheduleHint({ input, caret, onPickInterval }: Props): React.ReactElement {
  const result = parseScheduleCommand(input);
  const activeSlot = scheduleSlotAtCaret(input, caret);

  // Split the raw text around the error range so the offending segment can carry
  // the underline. Sliced from the same offsets the parser reported, so the
  // highlight can never drift from what was actually rejected.
  const marked = result.ok
    ? null
    : {
        before: input.slice(0, result.error.start),
        bad: input.slice(result.error.start, result.error.end),
        after: input.slice(result.error.end),
      };

  return (
    <div
      className="slash-menu schedule-hint"
      style={{ background: theme.surface2, borderColor: theme.border }}
    >
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        schedule
      </div>

      <div className="schedule-sig">
        <span className="schedule-sig-cmd" style={{ color: theme.commandColor }}>
          /schedule
        </span>
        {SLOTS.map(({ slot, label, hint }, i) => {
          const active = slot === activeSlot;
          return (
            <span key={slot} className="schedule-sig-slot">
              {i > 0 && (
                <span className="schedule-sig-bar" style={{ color: theme.textDim }}>
                  |
                </span>
              )}
              <span
                className={`schedule-slot${active ? " active" : ""}`}
                style={{ color: active ? theme.text : theme.textDim }}
                data-slot={slot}
                data-active={active ? "true" : "false"}
                title={hint}
              >
                {label}
              </span>
            </span>
          );
        })}
      </div>

      {!result.ok ? (
        <div className="schedule-status schedule-status-error">
          {/* The rejected text, underlined in place, so the message and the
              offending characters are read together rather than the user
              having to map an abstract complaint back onto their input. */}
          {marked && marked.bad.length > 0 && (
            <div className="schedule-echo" aria-hidden="true">
              <span style={{ color: theme.textDim }}>{marked.before}</span>
              <span className="schedule-echo-bad" style={{ color: theme.error }}>
                {marked.bad}
              </span>
              <span style={{ color: theme.textDim }}>{marked.after}</span>
            </div>
          )}
          <div className="schedule-msg" style={{ color: theme.error }} role="status">
            {result.error.message}
          </div>
        </div>
      ) : (
        <div className="schedule-status">
          <div className="schedule-msg" style={{ color: theme.success }} role="status">
            {describeSchedule(result.value)}
          </div>
        </div>
      )}

      {/* Presets fill the segment that gets mistyped most. The prompt is
          freeform text so it can't be offered this way, but the interval is a
          closed set of sensible values — and it is exactly where `15s` and
          `15 minutes` come from. */}
      <div className="schedule-presets">
        <span className="schedule-presets-label" style={{ color: theme.textMuted }}>
          every
        </span>
        {INTERVAL_PRESETS.map((preset) => (
          <button
            key={preset}
            className="schedule-preset"
            style={{ color: theme.text, borderColor: theme.border }}
            onClick={() => onPickInterval(preset)}
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  );
}
