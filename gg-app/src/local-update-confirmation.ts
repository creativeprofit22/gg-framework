import type { UpdatePhase } from "./update";

export const LOCAL_UPDATE_CONFIRMATION_TITLE = "Build patched local update?";

export const LOCAL_UPDATE_CONFIRMATION_MESSAGE =
  "This will update source, reapply your local fixes, and build a patched installer. It will not install the official binary.";

export const LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL = "Build patched installer";

export function shouldConfirmLocalUpdate(localPatched: boolean, phase: UpdatePhase): boolean {
  return localPatched && (phase === "available" || phase === "error");
}
