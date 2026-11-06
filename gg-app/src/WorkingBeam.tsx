/**
 * Decorative "agent is working" sweep around the composer and stop button.
 *
 * A sibling overlay: it never wraps or remounts the editable field or its
 * controls. The colour sweep is a pre-painted conic gradient that only
 * *rotates*, behind static edge masks. Transform animations run on the
 * compositor, so a working pane costs no per-frame style recalculation or
 * repaint on the UI thread. (The previous package animated registered custom
 * properties and filters, which forced both every frame in every working pane.)
 */
export function WorkingBeam({
  active,
  size = "md",
}: {
  active: boolean;
  size?: "md" | "sm";
}): React.ReactElement | null {
  if (!active) return null;

  return (
    <div className={`working-beam working-beam-${size}`} aria-hidden="true">
      <div className="working-beam-glow">
        <div className="working-beam-sweep" />
      </div>
      <div className="working-beam-ring">
        <div className="working-beam-sweep" />
      </div>
    </div>
  );
}
