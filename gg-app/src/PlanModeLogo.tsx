// The amber "PLAN MODE" banner shown when the agent enters plan mode. Set in
// the "Delta Corps Priest 1" FIGlet font, like the home screen's GG CODER
// banner. Every line is padded to the same width so the block art never
// shears, and the last row carries the L's descender.

import { useMemo } from "react";
import { CritterLine } from "./CritterLine";
import { pickCritter } from "./critter-sprites";
import { theme } from "./theme";

const PLAN_MODE_LOGO = [
  "   ▄███████▄  ▄█          ▄████████ ███▄▄▄▄          ▄▄▄▄███▄▄▄▄    ▄██████▄  ████████▄     ▄████████",
  "  ███    ███ ███         ███    ███ ███▀▀▀██▄      ▄██▀▀▀███▀▀▀██▄ ███    ███ ███   ▀███   ███    ███",
  "  ███    ███ ███         ███    ███ ███   ███      ███   ███   ███ ███    ███ ███    ███   ███    █▀ ",
  "  ███    ███ ███         ███    ███ ███   ███      ███   ███   ███ ███    ███ ███    ███  ▄███▄▄▄    ",
  "▀█████████▀  ███       ▀███████████ ███   ███      ███   ███   ███ ███    ███ ███    ███ ▀▀███▀▀▀    ",
  "  ███        ███         ███    ███ ███   ███      ███   ███   ███ ███    ███ ███    ███   ███    █▄ ",
  "  ███        ███▌    ▄   ███    ███ ███   ███      ███   ███   ███ ███    ███ ███   ▄███   ███    ███",
  " ▄████▀      █████▄▄██   ███    █▀   ▀█   █▀        ▀█   ███   █▀   ▀██████▀  ████████▀    ██████████",
  "             ▀                                                                                       ",
];

/**
 * The plan-mode banner, with the agent's reason on a critter line beneath it:
 * a critter (picked from the reason, so it stays put on re-render) standing in
 * the assistant-dot gutter beside the reason in plan-mode amber.
 */
export function PlanModeLogo({ reason }: { reason?: string }): React.ReactElement {
  const critter = useMemo(
    () => pickCritter(undefined, `plan-mode:${reason ?? ""}`, new Set()),
    [reason],
  );
  return (
    <div className="plan-logo" data-swap-row="">
      {/* Block-glyph art is gibberish read aloud; the sr-only label stands in. */}
      <div className="plan-logo-art" aria-hidden="true">
        {PLAN_MODE_LOGO.map((line, i) => (
          <div key={i} className="plan-logo-line" style={{ "--line": i } as React.CSSProperties}>
            {line}
          </div>
        ))}
      </div>
      <span className="sr-only">Plan mode</span>
      {reason ? (
        <div className="plan-logo-reason">
          <CritterLine critter={critter} tone="done" color={theme.warning} text={reason} />
        </div>
      ) : null}
    </div>
  );
}
