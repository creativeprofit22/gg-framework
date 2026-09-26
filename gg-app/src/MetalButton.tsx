import type { ComponentProps } from "react";
import { ActionMetal } from "./ActionMetal";

type MetalButtonProps = ComponentProps<"button"> & { windowFocused: boolean };

/** Keep native semantics and color classes; add only a decorative metal rim. */
export function MetalButton({
  windowFocused,
  children,
  disabled,
  ...props
}: MetalButtonProps): React.ReactElement {
  const unavailable =
    disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return (
    <span className="metal-button">
      <button {...props} disabled={disabled}>
        {children}
      </button>
      <ActionMetal active={!unavailable} windowFocused={windowFocused} variant="button" />
    </span>
  );
}
