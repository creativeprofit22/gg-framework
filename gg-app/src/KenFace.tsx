import { renderKenFace, type KenFaceFrame } from "./ken-face";

/**
 * Where the face is shown, which picks its expressions and choreography:
 * - `chat`: the gutter of a Ken reply. Idles with a blink and, while the reply
 *   streams in, talks.
 * - `on`: the "Ken is on." banner. Wakes up: eyes shut, then a happy hop.
 * - `off`: the "Ken is off." banner. Nods off: eyes close, he sinks, a "z" drifts up.
 */
export type KenFaceMood = "chat" | "on" | "off";

interface Props {
  mood: KenFaceMood;
  /** Chat only: the reply is still streaming, so his mouth moves. */
  talking?: boolean;
}

// The expressions never change, so build each SVG once rather than on every
// streamed token.
const FRAMES: Readonly<Record<KenFaceFrame, string>> = {
  base: renderKenFace("base"),
  blink: renderKenFace("blink"),
  talk: renderKenFace("talk"),
  happy: renderKenFace("happy"),
  sleepy: renderKenFace("sleepy"),
};

/** Stacked bottom to top; CSS fades the upper layers in and out over the first. */
function layersFor(mood: KenFaceMood, talking: boolean): readonly KenFaceFrame[] {
  switch (mood) {
    case "on":
      return ["sleepy", "happy"];
    case "off":
      return ["base", "sleepy"];
    case "chat":
      return talking ? ["base", "talk", "blink"] : ["base", "blink"];
  }
}

/** Ken's little animated pixel face (see ken-face.ts). Decorative. */
export function KenFace({ mood, talking = false }: Props): React.ReactElement {
  return (
    <span
      className={`ken-face ken-face-${mood}${talking ? " ken-face-talking" : ""}`}
      aria-hidden="true"
    >
      {layersFor(mood, talking).map((frame) => (
        <img
          key={frame}
          className={`ken-face-layer ken-face-${frame}`}
          src={FRAMES[frame]}
          alt=""
          draggable={false}
        />
      ))}
      {mood === "off" && <span className="ken-face-z">z</span>}
    </span>
  );
}
