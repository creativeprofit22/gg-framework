import { useState } from "react";
import { Volume2, VolumeOff } from "lucide-react";
import { theme } from "./theme";
import { isSoundEnabled, setSoundEnabled, playSound } from "./sounds";

/**
 * Titlebar control that toggles all UI sound effects on/off. State is persisted
 * per-machine in localStorage (see sounds.ts), so the choice survives restarts.
 * Plays a confirmation click when turning sound back on.
 */
export function SoundButton({
  variant = "icon",
}: {
  variant?: "icon" | "settings";
}): React.ReactElement {
  const [on, setOn] = useState(isSoundEnabled());

  function toggle(): void {
    const next = !on;
    setSoundEnabled(next);
    setOn(next);
    if (next) playSound("click");
  }

  const settingsVariant = variant === "settings";
  return (
    <button
      className={
        settingsVariant ? "modal-btn" : "btn btn-ghost btn-icon btn-nav-icon home-settings"
      }
      title={on ? "Sound effects on — click to mute" : "Sound effects muted — click to enable"}
      // The icon-only variant has no text: name it and expose on/off as pressed.
      aria-label={settingsVariant ? undefined : "Sound effects"}
      aria-pressed={settingsVariant ? undefined : on}
      style={on ? undefined : { color: theme.textMuted }}
      onClick={toggle}
    >
      {on ? (
        <Volume2 size={settingsVariant ? 16 : 20} aria-hidden="true" />
      ) : (
        <VolumeOff size={settingsVariant ? 16 : 20} aria-hidden="true" />
      )}
      {settingsVariant ? (on ? "Sound on" : "Sound off") : null}
    </button>
  );
}
