import { Image, ImageOff } from "lucide-react";
import { theme } from "./theme";
import { setMemesEnabled, useMemesEnabled } from "./memes";

/**
 * Toggle for the home-screen meme GIF layer. State is persisted per-machine in
 * localStorage (see memes.ts), so the choice survives restarts. Mirrors
 * SoundButton: an icon button for the titlebar and a labelled row for Settings.
 * The generic click sound is handled by App's global click listener, so this
 * button needs no sound of its own.
 */
export function MemesButton({
  variant = "icon",
}: {
  variant?: "icon" | "settings";
}): React.ReactElement {
  const on = useMemesEnabled();

  const settingsVariant = variant === "settings";
  return (
    <button
      className={
        settingsVariant ? "modal-btn" : "btn btn-ghost btn-icon btn-nav-icon home-settings"
      }
      title={on ? "Meme GIFs on — click to hide" : "Meme GIFs hidden — click to show"}
      style={on ? undefined : { color: theme.textMuted }}
      onClick={() => setMemesEnabled(!on)}
    >
      {on ? (
        <Image size={settingsVariant ? 16 : 20} />
      ) : (
        <ImageOff size={settingsVariant ? 16 : 20} />
      )}
      {settingsVariant ? (on ? "Memes on" : "Memes off") : null}
    </button>
  );
}
