import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { withViewTransition } from "./view-transition";

/** Retain only until the browser captures the exit, never for a timed delay.
 * Owners change their logical state and run selection callbacks immediately.
 * The retained surface is inert; after capture only a browser snapshot remains.
 * Keep this boundary mounted when the menu's data/visibility disappears.
 */
export function FloatingSurface({
  children,
}: {
  children: React.ReactElement | null | false;
}): React.ReactElement {
  const [retained, setRetained] = useState(children);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const present = Boolean(children);
  const shell = useRef<HTMLSpanElement>(null);
  if (children && retained !== children) setRetained(children);

  useLayoutEffect(() => {
    if (present || !shell.current?.firstElementChild) return;
    let disposed = false;
    const transition = withViewTransition(() => {
      if (!disposed) setRetained(null);
    }, true);
    return () => {
      disposed = true;
      transition?.skipTransition();
    };
  }, [present]);

  return (
    <span
      ref={shell}
      className="floating-surface"
      data-exiting={!present && retained ? "" : undefined}
      inert={!present}
      aria-hidden={!present || undefined}
      style={{ "--floating-name": `gg-floating-${id}` } as CSSProperties}
      onClickCapture={(event) => {
        if (!present) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (!present) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children || retained}
    </span>
  );
}
