import { WavesIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { setHomeBackgroundEnabled, useHomeBackgroundEnabled } from "./home-background";

/**
 * Settings → Effects switch for the home screen's animated background, shaped
 * like the sound switch beside it.
 */
export function HomeBackgroundButton(): React.ReactElement {
  const on = useHomeBackgroundEnabled();
  return (
    <button
      className="modal-btn"
      type="button"
      aria-pressed={on}
      title={
        on
          ? "Home background on — click to turn it off"
          : "Home background off — click to turn it on"
      }
      style={on ? undefined : { color: theme.textMuted }}
      onClick={() => setHomeBackgroundEnabled(!on)}
    >
      <WavesIcon size={16} aria-hidden="true" />
      {on ? "Background on" : "Background off"}
    </button>
  );
}
