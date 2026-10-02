import { ComposerStarters } from "./ComposerStarters";
import { MOTION_STARTERS } from "./motion-starters";

export function MotionStarters({
  onPick,
}: {
  onPick: (prompt: string) => void;
}): React.ReactElement {
  return (
    <ComposerStarters
      starters={MOTION_STARTERS}
      label="Video ideas to start from"
      onPick={onPick}
    />
  );
}
