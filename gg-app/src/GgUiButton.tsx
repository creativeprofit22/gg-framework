import { Sparkles } from "lucide-react";
import { theme } from "./theme";
import { setGgUiEnabled, useGgUiEnabled } from "./gg-ui";

export function GgUiButton(): React.ReactElement {
  const on = useGgUiEnabled();
  return (
    <button
      className="modal-btn"
      aria-pressed={on}
      title={on ? "Use the original button styling" : "Use the metallic button styling"}
      style={on ? undefined : { color: theme.textMuted }}
      onClick={() => setGgUiEnabled(!on)}
    >
      <Sparkles size={16} aria-hidden="true" />
      GG UI {on ? "on" : "off"}
    </button>
  );
}
