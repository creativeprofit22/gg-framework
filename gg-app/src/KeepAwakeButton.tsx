import { useEffect, useState } from "react";
import { CoffeeIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Badge } from "./Badge";
import { getKeepAwake, setKeepAwake } from "./agent";
import { toast } from "./toast";

/**
 * Settings switch for keeping the computer from idle-sleeping while the agent
 * works, shaped like the Effects switches. Saved by the sidecar and applied
 * live, including to a run already in progress.
 */
export function KeepAwakeButton(): React.ReactElement {
  // null until the sidecar answers; the setting defaults to on.
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getKeepAwake()
      .then((enabled) => {
        if (!cancelled) setOn(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(): Promise<void> {
    if (on === null || busy) return;
    setBusy(true);
    try {
      setOn(await setKeepAwake(!on));
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const checked = on ?? true;
  return (
    <>
      <button
        className="modal-btn"
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={on === null || busy}
        title={
          checked
            ? "On — your computer won't fall asleep mid-task. The screen can still turn off."
            : "Off — your computer may sleep while the agent is working."
        }
        style={checked ? undefined : { color: theme.textMuted }}
        onClick={() => void toggle()}
      >
        <CoffeeIcon size={16} aria-hidden="true" />
        Keep computer awake while the agent works
      </button>
      <Badge color={checked ? theme.success : theme.textMuted}>{checked ? "On" : "Off"}</Badge>
    </>
  );
}
