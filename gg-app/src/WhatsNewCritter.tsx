import { useMemo, useState } from "react";
import { CRITTERS, renderCritterFrame, type CritterDef } from "./critter-sprites";

/** Pick a random critter (a fresh one each time the window opens). */
export function randomCritter(random: () => number = Math.random): CritterDef {
  const critter = CRITTERS[Math.floor(random() * CRITTERS.length)] ?? CRITTERS[0];
  if (!critter) throw new Error("the critter roster is empty");
  return critter;
}

/**
 * A little critter pacing back and forth beside the "What's new" title: it
 * walks right, turns round, walks back, and repeats, stepping between its two
 * walk frames. Hoppers and floaters bob as they go. Purely decorative.
 * Reduced motion: it just stands there.
 */
export function WhatsNewCritter({
  random = Math.random,
}: {
  random?: () => number;
}): React.ReactElement {
  const [critter] = useState(() => randomCritter(random));
  const [frameA, frameB] = useMemo(
    () => [renderCritterFrame(critter, 0), renderCritterFrame(critter, 1)],
    [critter],
  );
  const bobs = critter.move !== "walk" && critter.move !== "scuttle";
  return (
    <span className="whatsnew-critter-lane" aria-hidden="true" title="">
      <span className="whatsnew-critter" data-critter={critter.id}>
        <span className={`whatsnew-critter-body${bobs ? " bob" : ""}`}>
          <img src={frameA} alt="" draggable={false} />
          <img className="whatsnew-critter-step" src={frameB} alt="" draggable={false} />
        </span>
      </span>
    </span>
  );
}
