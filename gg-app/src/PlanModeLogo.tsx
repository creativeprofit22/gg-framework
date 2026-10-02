// Web port of packages/ggcoder/src/ui/components/PlanModeLogo.tsx — the amber
// ASCII "PLAN MODE" banner shown when the agent enters plan mode.

const PLAN_MODE_LOGO = [
  "▗▄▄▖ ▗▖    ▗▄▖ ▗▖  ▗▖    ▗▖  ▗▖ ▗▄▖ ▗▄▄▄ ▗▄▄▄▖",
  "▐▌ ▐▌▐▌   ▐▌ ▐▌▐▛▚▖▐▌    ▐▛▚▞▜▌▐▌ ▐▌▐▌  █▐▌",
  "▐▛▀▘ ▐▌   ▐▛▀▜▌▐▌ ▝▜▌    ▐▌  ▐▌▐▌ ▐▌▐▌  █▐▛▀▀▘",
  "▐▌   ▐▙▄▄▖▐▌ ▐▌▐▌  ▐▌    ▐▌  ▐▌▝▚▄▞▘▐▙▄▄▀▐▙▄▄▖",
];

// "YOUR PLAN" banner shown in the plan-review modal (mirrors the TUI's
// YOUR_PLAN_LOGO in PlanOverlay.tsx).
const YOUR_PLAN_LOGO = [
  "▗▖  ▗▖▗▄▖ ▗▖ ▗▖▗▄▄▖     ▗▄▄▖ ▗▖    ▗▄▖ ▗▖  ▗▖",
  " ▝▚▞▘▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌    ▐▌ ▐▌▐▌   ▐▌ ▐▌▐▛▚▖▐▌",
  "  ▐▌ ▐▌ ▐▌▐▌ ▐▌▐▛▀▚▖    ▐▛▀▘ ▐▌   ▐▛▀▜▌▐▌ ▝▜▌",
  "  ▐▌ ▝▚▄▞▘▝▚▄▞▘▐▌ ▐▌    ▐▌   ▐▙▄▄▖▐▌ ▐▌▐▌  ▐▌",
];

// Tuned around the verified --warning hue (#e3a23f, OKLCH 76/74).
const AMBER_GRADIENT = [
  "#e3a23f",
  "#f0b860",
  "#e3a23f",
  "#c98828",
  "#e3a23f",
  "#f0b860",
  "#c98828",
];

/** Per-glyph amber gradient sweep, mirroring the TUI PlanGradientText. */
function GradientLine({ text }: { text: string }): React.ReactElement {
  let colorIdx = 0;
  return (
    <div className="plan-logo-line">
      {Array.from(text).map((ch, i) => {
        if (ch === " ") return <span key={i}>{"\u00a0"}</span>;
        const color = AMBER_GRADIENT[colorIdx % AMBER_GRADIENT.length];
        colorIdx++;
        return (
          <span key={i} style={{ color }}>
            {ch}
          </span>
        );
      })}
    </div>
  );
}

export function PlanModeLogo({ reason }: { reason?: string }): React.ReactElement {
  return (
    <div className="plan-logo" data-swap-row="">
      {PLAN_MODE_LOGO.map((line, i) => (
        <GradientLine key={i} text={line} />
      ))}
      {reason ? <div className="plan-logo-reason">{reason}</div> : null}
    </div>
  );
}

/** Amber "YOUR PLAN" banner for the plan-review modal. */
export function YourPlanLogo(): React.ReactElement {
  return (
    <div className="plan-logo">
      {YOUR_PLAN_LOGO.map((line, i) => (
        <GradientLine key={i} text={line} />
      ))}
    </div>
  );
}
