import { lazy, Suspense } from "react";
import type { ThinkingOrbProps } from "thinking-orbs";

function OrbPlaceholder({ size = 64, style }: ThinkingOrbProps): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-block", width: size, height: size, ...style }}
    />
  );
}

// Decorative animation is not needed to read status or cancel a task. Keep it
// out of the initial bundle, and retain the row geometry if its chunk fails.
const AnimatedOrb = lazy(() =>
  import("thinking-orbs")
    .then(({ ThinkingOrb }) => ({ default: ThinkingOrb }))
    .catch(() => ({ default: OrbPlaceholder })),
);

export function ThinkingOrb(props: ThinkingOrbProps): React.ReactElement {
  return (
    <Suspense fallback={<OrbPlaceholder {...props} />}>
      <AnimatedOrb {...props} />
    </Suspense>
  );
}
