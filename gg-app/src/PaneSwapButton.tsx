import { ArrowLeft, ArrowRight, ArrowLeftRight } from "lucide-react";
import { useId, type Ref } from "react";

export interface PaneSwapButtonProps {
  paneId: string;
  label: string;
  helpId: string;
  direction?: "left" | "right";
  unavailableReason?: string;
  buttonRef: Ref<HTMLButtonElement>;
  onSwap: (paneId: string, buttonActivation: boolean, keyboard: boolean) => void;
}
export function PaneSwapButton({
  paneId,
  label,
  helpId,
  buttonRef,
  onSwap,
  direction,
  unavailableReason,
}: PaneSwapButtonProps) {
  const unavailableId = useId();
  const name = direction ? `Swap with ${direction} pane: ${label}` : `Swap with middle: ${label}`;
  const Icon =
    direction === "left" ? ArrowLeft : direction === "right" ? ArrowRight : ArrowLeftRight;
  return (
    <>
      <button
        type="button"
        className="pane-swap-button"
        ref={buttonRef}
        disabled={Boolean(unavailableReason)}
        data-pane-swap={paneId}
        data-pane-swap-direction={direction}
        aria-label={name}
        aria-describedby={unavailableReason ? `${helpId} ${unavailableId}` : helpId}
        title={unavailableReason ?? name}
        onKeyDown={(event) => {
          if (
            (event.key === "Enter" || event.key === " ") &&
            (event.repeat || event.nativeEvent.isComposing || event.getModifierState("AltGraph"))
          )
            event.preventDefault();
        }}
        onClick={(event) => onSwap(paneId, true, event.detail === 0)}
      >
        <Icon size={15} aria-hidden="true" />
      </button>
      {unavailableReason && (
        <span id={unavailableId} hidden>
          {unavailableReason}
        </span>
      )}
    </>
  );
}
