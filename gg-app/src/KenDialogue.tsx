import { useCallback, useEffect, useRef, useState } from "react";
import type { FloorAgent } from "./critter-floor";
import { drawKenPortrait } from "./goal-ken-portrait";
import {
  EMPTY_QUEUE,
  enqueue,
  holdMsFor,
  markHeard,
  nextLine,
  ownLine,
  workerLine,
  type KenLine,
  type KenSaid,
  type TalkQueue,
} from "./goal-ken-talk";

interface Props {
  /** Ken's newest spoken line, from the end of his latest message. */
  readonly said: KenSaid | null;
  /** The workers, to say when one finishes or fails. */
  readonly workers: readonly FloorAgent[];
  /**
   * Keep quiet: a sign is up over the farm (a question, or the finish card).
   * A line already under way stops where it is, so the sign never shares the
   * screen with him; it isn't said again.
   */
  readonly paused: boolean;
  /** Don't start a new line for now (the user is reading Ken's status). */
  readonly held?: boolean;
  readonly reducedMotion: boolean;
  /** Told when the box comes up and when it has gone again. */
  readonly onShownChange?: (shown: boolean) => void;
}

// Entrance and exit lengths; they match the CSS (App.css, .ken-dialogue):
// in, Ken's rise starts at 130ms and springs for --duration-spring (0.5s).
const ENTER_MS = 600;
const EXIT_MS = 300;
const REDUCED_FADE_MS = 120;
/** Typing speed, and how often his mouth opens and shuts while he types. */
const CHAR_MS = 30;
const MOUTH_MS = 110;
/** How often the queue is checked for something to say. */
const TICK_MS = 500;

type Phase = "hidden" | "entering" | "talking" | "leaving";

/**
 * Little Ken, bottom left of the Workers view, saying something now and then
 * like a game's dialogue box: his portrait behind a parchment box, his name
 * plate on its top edge, the line typing out while his mouth moves. Hidden
 * most of the time; it pops up only when there's something to say (his own
 * short line at the end of a message, or a worker finishing or failing; see
 * goal-ken-talk) and leaves again after a moment. Click to finish the line,
 * click again to send him off early.
 *
 * Ken's whole messages (tables, code, long reports) never appear here; they
 * stay in the chat. Lines already true when the farm opens aren't said:
 * every time the view is shown it starts from what's new.
 */
export function KenDialogue({
  said,
  workers,
  paused,
  held = false,
  reducedMotion,
  onShownChange,
}: Props): React.ReactElement {
  const queueRef = useRef<TalkQueue>(EMPTY_QUEUE);
  const statusRef = useRef<Map<string, FloorAgent["status"]>>(new Map());
  const [line, setLine] = useState<KenLine | null>(null);
  const [phase, setPhase] = useState<Phase>("hidden");
  const [shown, setShown] = useState(0);
  const [mouthOpen, setMouthOpen] = useState(false);
  const [blink, setBlink] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const enterMs = reducedMotion ? REDUCED_FADE_MS : ENTER_MS;
  const exitMs = reducedMotion ? REDUCED_FADE_MS : EXIT_MS;
  const length = line?.text.length ?? 0;
  const typing = phase === "talking" && shown < length;

  // Each time the view is shown, start from what's new: what Ken last said
  // and how the workers stand count as heard, not said. Effects run again
  // when Activity reveals the view; `fresh` is true for that first run (the
  // effect after these two clears it, and its cleanup sets it on hide).
  const fresh = useRef(true);

  useEffect(() => {
    if (!said) return;
    queueRef.current = fresh.current
      ? markHeard(queueRef.current, [ownLine(said).id])
      : enqueue(queueRef.current, ownLine(said), Date.now());
  }, [said]);

  useEffect(() => {
    const before = statusRef.current;
    const next = new Map<string, FloorAgent["status"]>();
    for (const worker of workers) {
      next.set(worker.key, worker.status);
      const was = before.get(worker.key);
      if (fresh.current || was !== "running") continue;
      const to =
        worker.status === "done" || worker.status === "idle"
          ? "done"
          : worker.status === "error" || worker.status === "interrupted"
            ? "error"
            : null;
      if (!to) continue;
      queueRef.current = enqueue(
        queueRef.current,
        // Each finish is its own event: a follow-up task can finish again.
        workerLine({ key: `${worker.key}:${worker.toolUseCount}`, name: worker.label, to }),
        Date.now(),
      );
    }
    statusRef.current = next;
  }, [workers]);

  useEffect(() => {
    fresh.current = false;
    return () => {
      fresh.current = true;
    };
  }, []);

  // Something to say? Only while the box is down and nothing else is up.
  useEffect(() => {
    if (phase !== "hidden" || paused || held) return;
    const check = (): void => {
      const { line: next, queue } = nextLine(queueRef.current, Date.now(), false);
      queueRef.current = queue;
      if (!next) return;
      setLine(next);
      setShown(reducedMotion ? next.text.length : 0);
      setPhase("entering");
    };
    check();
    const id = window.setInterval(check, TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, paused, held, reducedMotion]);

  // A sign went up while he was talking: he stops and goes.
  useEffect(() => {
    if (paused && (phase === "entering" || phase === "talking")) setPhase("leaving");
  }, [paused, phase]);

  // Up from the moment he starts coming in until he has fully gone.
  const shownNow = phase !== "hidden";
  const onShownChangeRef = useRef(onShownChange);
  useEffect(() => {
    onShownChangeRef.current = onShownChange;
  }, [onShownChange]);
  useEffect(() => {
    onShownChangeRef.current?.(shownNow);
  }, [shownNow]);

  // The phases: in, type out and hold, out.
  useEffect(() => {
    if (phase === "entering") {
      const id = window.setTimeout(() => setPhase("talking"), enterMs);
      return () => window.clearTimeout(id);
    }
    if (phase === "leaving") {
      const id = window.setTimeout(() => {
        setPhase("hidden");
        setLine(null);
      }, exitMs);
      return () => window.clearTimeout(id);
    }
    if (phase === "talking" && line && !typing) {
      const id = window.setTimeout(() => setPhase("leaving"), holdMsFor(line));
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [phase, line, typing, enterMs, exitMs]);

  // Typing, with his mouth moving (shut on spaces and stops).
  useEffect(() => {
    if (!typing || !line) {
      setMouthOpen(false);
      return;
    }
    const id = window.setTimeout(() => {
      const next = shown + 1;
      setShown(next);
      const ch = line.text[next - 1] ?? " ";
      setMouthOpen(!/[\s.,!?:;…]/.test(ch) && Math.floor(performance.now() / MOUTH_MS) % 2 === 0);
    }, CHAR_MS);
    return () => window.clearTimeout(id);
  }, [typing, line, shown]);

  // He blinks now and then while he's up.
  useEffect(() => {
    if (phase === "hidden" || reducedMotion) return;
    let shut: number | undefined;
    const id = window.setInterval(() => {
      setBlink(true);
      shut = window.setTimeout(() => setBlink(false), 130);
    }, 3100);
    return () => {
      window.clearInterval(id);
      if (shut !== undefined) window.clearTimeout(shut);
    };
  }, [phase, reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && line) drawKenPortrait(canvas, line.face, { talk: mouthOpen, blink });
  }, [line, mouthOpen, blink]);

  // The whole line is out once he's talking and typing is done.
  const lineOut = phase === "talking" && !typing;
  const onClick = useCallback(() => {
    if (!line) return;
    if (lineOut) setPhase("leaving");
    else setShown(line.text.length);
  }, [line, lineOut]);

  const up = phase === "entering" || phase === "talking";
  return (
    <div className="ken-dialogue" data-phase={phase}>
      <div className="ken-dialogue-portrait" aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <button
        type="button"
        className="ken-dialogue-box"
        tabIndex={up ? 0 : -1}
        aria-label={line ? `Ken: ${line.text}. ${lineOut ? "Dismiss" : "Show all"}` : undefined}
        onClick={onClick}
      >
        <span className="ken-dialogue-name">Ken</span>
        <span className="ken-dialogue-text" aria-hidden="true">
          {line?.text.slice(0, shown)}
        </span>
        <span className="ken-dialogue-more" data-on={lineOut ? "" : undefined} />
      </button>
      {/* Read out once, whole, when he starts the line (not letter by letter). */}
      <p className="sr-only" aria-live="polite">
        {line && phase !== "leaving" ? `Ken: ${line.text}` : ""}
      </p>
    </div>
  );
}
