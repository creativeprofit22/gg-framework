import { useState } from "react";
import { SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { isSoundEnabled, setSoundEnabled, playSound } from "./sounds";

/**
 * Toggles all UI sound effects on/off. State is persisted per-machine in
 * localStorage (see sounds.ts), so the choice survives restarts. Plays a
 * confirmation click when turning sound back on.
 *
 * Settings → Effects toggle: the name stays "Sound effects" and on/off is
 * carried by `aria-pressed`, the speaker icon and the shared `.toggle-btn`
 * styling.
 */
export function SoundButton(): React.ReactElement {
  const [on, setOn] = useState(isSoundEnabled());

  function toggle(): void {
    const next = !on;
    setSoundEnabled(next);
    setOn(next);
    if (next) playSound("click");
  }

  const Icon = on ? SpeakerHighIcon : SpeakerSlashIcon;
  return (
    <button
      type="button"
      className="modal-btn toggle-btn"
      title={on ? "Sound effects on — click to mute" : "Sound effects muted — click to enable"}
      aria-pressed={on}
      onClick={toggle}
    >
      <Icon size={16} aria-hidden="true" />
      Sound effects
    </button>
  );
}
