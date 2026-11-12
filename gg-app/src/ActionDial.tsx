import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { dialLayout, dialShift } from "./composer-actions";

/** Long-press threshold. Mirrors --dur-dial-hold (scripts/motion-tokens.test.mjs). */
const HOLD_MS = 320;
/** Half a touch-size petal plus breathing room, kept clear of the composer edges. */
const PETAL_MARGIN = 28;

export interface DialOption<Id extends string = string> {
  id: Id;
  label: string;
  icon: ReactNode;
  /** Tooltip while the option can run. */
  hint: string;
  /** Why the option can't run right now; null or absent when it can. */
  blocked?: string | null;
  /** The option's own surface is open (shown as the hub's active state). */
  expanded?: boolean;
  run: () => void;
}

interface ActionDialProps<Id extends string> {
  options: readonly DialOption<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
}

/**
 * A label or icon that rolls in when it replaces another. `armed` is read once,
 * at mount: adding the class to an element already on screen would start the
 * animation on it too.
 */
function RollIn({
  armed,
  className,
  children,
}: {
  armed: boolean;
  className: string;
  children: ReactNode;
}) {
  const [rolls] = useState(armed);
  return <span className={rolls ? `${className} is-rolling` : className}>{children}</span>;
}

/**
 * One button, several actions. A click runs the option the button shows. Holding
 * it (or right-clicking, or ArrowUp/ArrowDown) opens a dial of options around it;
 * releasing over one, clicking one, or Enter picks it. Picking only switches the
 * button: nothing runs until the next click.
 */
export function ActionDial<Id extends string>({
  options,
  selected,
  onSelect,
}: ActionDialProps<Id>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The press that opened the dial is still down: release over a petal picks it.
  const draggingRef = useRef(false);
  // Swallow the click that follows a hold or a keyboard pick.
  const suppressClickRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const [highlight, setHighlight] = useState<Id | null>(null);
  const [shift, setShift] = useState(0);
  // Labels and icons mounted after the first open roll in; the ones on screen
  // at mount (and through the first open) never replay.
  const [rolled, setRolled] = useState(false);
  // Keys that replay the run ripple.
  const [fires, setFires] = useState(0);
  const menuId = useId();

  const points = dialLayout(options.length);
  const current = options.find((option) => option.id === selected) ?? options[0];
  const previewed = open ? options.find((option) => option.id === highlight) : undefined;
  const shown = previewed ?? current;

  function clearHold(): void {
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }

  function openDial(): void {
    const root = rootRef.current;
    if (root) {
      const box = root.getBoundingClientRect();
      const bounds = (
        root.closest(".inputwrap") ?? document.documentElement
      ).getBoundingClientRect();
      setShift(
        dialShift(box.left + box.width / 2, points, bounds.left, bounds.right, PETAL_MARGIN),
      );
    }
    setHighlight(selected);
    setRolled(true);
    setOpen(true);
  }

  function closeDial(): void {
    draggingRef.current = false;
    setOpen(false);
    setHighlight(null);
  }

  function choose(id: Id): void {
    closeDial();
    if (id !== selected) onSelect(id);
  }

  /** The option under a viewport point, if it is one of this dial's petals. */
  function optionAt(x: number, y: number): Id | null {
    const hit =
      typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    const petal = hit?.closest<HTMLElement>("[data-dial-option]");
    if (!petal || !rootRef.current?.contains(petal)) return null;
    return options.find((option) => option.id === petal.dataset.dialOption)?.id ?? null;
  }

  useEffect(() => clearHold, []);

  // Any press outside the dial closes it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      closeDial();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (!current) return null;

  function onPointerDown(event: PointerEvent<HTMLButtonElement>): void {
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    if (open) {
      suppressClickRef.current = true;
      closeDial();
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearHold();
    setHolding(true);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setHolding(false);
      suppressClickRef.current = true;
      draggingRef.current = true;
      openDial();
    }, HOLD_MS);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>): void {
    if (draggingRef.current) setHighlight(optionAt(event.clientX, event.clientY));
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>): void {
    if (holdTimerRef.current !== null) {
      // Released before the threshold: an ordinary click follows.
      clearHold();
      setHolding(false);
      return;
    }
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const id = optionAt(event.clientX, event.clientY);
    // Released away from every petal: the dial stays open for a click.
    if (id !== null) choose(id);
    else setHighlight(selected);
  }

  function onPointerCancel(): void {
    clearHold();
    setHolding(false);
    draggingRef.current = false;
  }

  function onClick(): void {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (open) {
      closeDial();
      return;
    }
    if (!current || current.blocked) return;
    current.run();
    setFires((count) => count + 1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    suppressClickRef.current = false;
    if (!open) {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)
      ) {
        event.preventDefault();
        openDial();
      }
      return;
    }
    const from = options.findIndex((option) => option.id === (highlight ?? selected));
    const step = (delta: number): void => {
      const next = options[(from + delta + options.length) % options.length];
      if (next) setHighlight(next.id);
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        suppressClickRef.current = true;
        choose(highlight ?? selected);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeDial();
        break;
      case "Tab":
        closeDial();
        break;
    }
  }

  const title = open
    ? "Release on an action, or click one, to switch"
    : `${current.blocked ?? current.hint} · Hold to switch actions`;

  return (
    <div
      ref={rootRef}
      className="action-dial"
      data-open={open || undefined}
      data-holding={holding || undefined}
      style={{ "--dial-shift": `${shift}px` } as CSSProperties}
    >
      <button
        type="button"
        className="btn btn-ghost btn-sm action-dial-hub"
        aria-label={shown.label}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={current.expanded}
        aria-disabled={current.blocked ? true : undefined}
        aria-activedescendant={open && highlight !== null ? `${menuId}-${highlight}` : undefined}
        title={title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!open) openDial();
        }}
      >
        <span className="action-dial-orb" aria-hidden="true">
          <span className="action-dial-hold" />
          <RollIn key={shown.id} armed={rolled} className="action-dial-icon">
            {shown.icon}
          </RollIn>
          {fires > 0 && <span key={fires} className="action-dial-ripple" />}
        </span>
        <span className="action-dial-label-slot" aria-hidden="true">
          {/* Every label sizes the slot, so the pill keeps one width while
              the dial previews options (petals stay put under the pointer). */}
          {options.map((option) => (
            <span key={option.id} className="action-dial-sizer">
              {option.label}
            </span>
          ))}
          <RollIn key={shown.id} armed={rolled} className="action-dial-label">
            {shown.label}
          </RollIn>
        </span>
      </button>
      <div
        id={menuId}
        className="action-dial-ring"
        role="menu"
        aria-label="Actions"
        aria-hidden={!open}
        inert={!open}
      >
        <span className="action-dial-halo" aria-hidden="true" />
        <span className="action-dial-wave" aria-hidden="true" />
        {options.map((option, index) => {
          const point = points[index] ?? { x: 0, y: 0 };
          return (
            <button
              key={option.id}
              id={`${menuId}-${option.id}`}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === selected}
              aria-label={option.label}
              title={option.label}
              tabIndex={-1}
              className="action-dial-petal"
              data-dial-option={option.id}
              data-highlight={option.id === highlight || undefined}
              style={
                {
                  "--dial-x": `${point.x}px`,
                  "--dial-y": `${point.y}px`,
                  "--dial-i": index,
                } as CSSProperties
              }
              onPointerEnter={() => setHighlight(option.id)}
              onPointerLeave={() => setHighlight((id) => (id === option.id ? null : id))}
              onClick={() => choose(option.id)}
            >
              {option.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}
