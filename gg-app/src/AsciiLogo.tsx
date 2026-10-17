import { PRODUCT_DISPLAY_NAME } from "./brand";

// Centered "SUPAH CODER" ASCII banner with a horizontal gradient + animated
// shimmer sweep. Mirrors the brand gradient used across the CLI logos. Every
// line is padded to the same width: the home screen centres text, so ragged
// lines would each centre on their own and shear the letters apart.
const RAW_LOGO_LINES = [
  "███████╗██╗   ██╗██████╗  █████╗ ██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗██████╗ ",
  "██╔════╝██║   ██║██╔══██╗██╔══██╗██║  ██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗",
  "███████╗██║   ██║██████╔╝███████║███████║    ██║     ██║   ██║██║  ██║█████╗  ██████╔╝",
  "╚════██║██║   ██║██╔═══╝ ██╔══██║██╔══██║    ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗",
  "███████║╚██████╔╝██║     ██║  ██║██║  ██║    ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

const LOGO_WIDTH = Math.max(...RAW_LOGO_LINES.map((line) => line.length));
const LOGO_LINES = RAW_LOGO_LINES.map((line) => line.padEnd(LOGO_WIDTH, " "));

const LOGO_TEXT = LOGO_LINES.join("\n");

/**
 * The banner, with a quiet, colourless glitch loop: every few seconds, for a
 * fraction of a second, the banner jolts and a thin band of rows tears
 * sideways, then everything snaps back. The tearing bands are drawn from
 * `data-text` by CSS, so the banner's text exists once for screen readers.
 */
export function AsciiLogo(): React.ReactElement {
  return (
    <div className="ascii-logo" role="img" aria-label={PRODUCT_DISPLAY_NAME}>
      <div className="ascii-logo-glitch" data-text={LOGO_TEXT} aria-hidden="true">
        {LOGO_LINES.map((line, i) => (
          <div className="ascii-logo-line" key={i}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
