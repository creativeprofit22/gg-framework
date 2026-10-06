// Click-to-spook reactions, cycled per critter so every click differs. If the
// critter was holding something, it drops it first.

import { PRIO } from "./critter-types";
import type { Critter, CritterApi } from "./critter-types";

export interface CritterScare {
  scare(c: Critter): void;
}

type Reaction = (c: Critter) => Promise<void>;

export function makeCritterScare(api: CritterApi): CritterScare {
  const { fx } = api;
  const { wait, play } = fx;

  const SCARES: readonly Reaction[] = [
    // Startle jump.
    async (c) => {
      fx.setBadge(c, "yikes", "!");
      await play(
        c.body,
        [
          { transform: "none" },
          { transform: "scale(1.25, 0.7)", offset: 0.12 },
          { transform: "translateY(-26px) scale(0.85, 1.2)", offset: 0.45 },
          { transform: "translateY(-26px) scale(0.9, 1.1)", offset: 0.55 },
          { transform: "translateY(0) scale(1.3, 0.7)", offset: 0.82 },
          { transform: "none" },
        ],
        { duration: 700, easing: "ease-in-out" },
      );
    },
    // Bolts away.
    async (c) => {
      fx.setBadge(c, "yikes", "!!");
      const shake: Keyframe[] = [];
      for (let i = 0; i < 4; i++) shake.push({ transform: `translateX(${i % 2 ? 2 : -2}px)` });
      shake.push({ transform: "none" });
      await play(c.body, shake, { duration: 200 });
      fx.setBadge(c, null);
      c.next = { flee: 0.75, dir: c.x > api.floorWidth() / 2 ? -1 : 1 };
    },
    // Shivers.
    async (c) => {
      fx.setBadge(c, "yikes", "?!");
      c.sil.animate(
        [{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }, { opacity: 0.6 }, { opacity: 0 }],
        { duration: 420 },
      );
      const frames: Keyframe[] = [];
      for (let i = 0; i <= 14; i++) {
        frames.push({ transform: `translateX(${i % 2 ? 1.5 : -1.5}px) scale(0.96, 0.94)` });
      }
      frames.push({ transform: "none" });
      await play(c.body, frames, { duration: 750, easing: "linear" });
    },
    // Panic backflip.
    async (c) => {
      fx.setBadge(c, "yikes", "!");
      const spin = c.dir > 0 ? -360 : 360;
      await play(
        c.body,
        [
          { transform: "none" },
          { transform: "scale(1.2, 0.75)", offset: 0.12 },
          { transform: `translateY(-24px) rotate(${spin / 2}deg)`, offset: 0.5 },
          { transform: `translateY(0) rotate(${spin}deg) scale(1.2, 0.8)`, offset: 0.85 },
          { transform: `rotate(${spin}deg)` },
        ],
        { duration: 760, easing: "ease-in-out" },
      );
      fx.sparks(c, 6);
    },
    // Ducks and covers.
    async (c) => {
      fx.setBadge(c, "yikes", "eep");
      await play(
        c.body,
        [
          { transform: "none" },
          { transform: "scale(1.3, 0.35)", offset: 0.12 },
          { transform: "translateX(-1px) scale(1.3, 0.35)", offset: 0.3 },
          { transform: "translateX(1px) scale(1.3, 0.35)", offset: 0.45 },
          { transform: "translateX(-1px) scale(1.3, 0.35)", offset: 0.6 },
          { transform: "scale(1.2, 0.5)", offset: 0.75 },
          { transform: "scale(0.95, 1.08)", offset: 0.9 },
          { transform: "none" },
        ],
        { duration: 1300, easing: "ease-in-out" },
      );
    },
  ];

  /** Click handler: drop whatever it holds, then react. */
  function scare(c: Critter): void {
    const status = c.agent.status;
    if (c.leaving || status === "done" || status === "error") return;
    const reaction = SCARES[c.scareIndex % SCARES.length];
    if (!reaction) return;
    c.scareIndex++;
    const hadProps = c.react.querySelector(".critter-prop") !== null;
    if (hadProps) fx.dropProps(c);
    void api.perform(c, PRIO.scare, async (ok) => {
      await reaction(c);
      fx.setBadge(c, null);
      if (!ok()) return;
      if (hadProps && fx.chance(0.5)) {
        fx.say(c, fx.pick(["my stuff!", "aw man", "where was I…"]), 1000, true);
      }
      await wait(150);
    });
  }

  return { scare };
}
