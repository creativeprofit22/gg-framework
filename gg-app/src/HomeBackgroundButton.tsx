import { SunHorizonIcon } from "@phosphor-icons/react";
import { setHomeBackgroundEnabled, useHomeBackgroundEnabled } from "./home-background";

/**
 * Settings → Effects toggle for the home screen's animated background, shaped
 * like the sound toggle beside it. The name stays "Home background"; on/off is
 * carried by `aria-pressed` and the shared `.toggle-btn` styling.
 */
export function HomeBackgroundButton(): React.ReactElement {
  const on = useHomeBackgroundEnabled();
  return (
    <button
      className="modal-btn toggle-btn"
      type="button"
      aria-pressed={on}
      title={
        on
          ? "Home background on — click to turn it off"
          : "Home background off — click to turn it on"
      }
      onClick={() => setHomeBackgroundEnabled(!on)}
    >
      <SunHorizonIcon size={16} aria-hidden="true" />
      Home background
    </button>
  );
}
