import type { UpdatePhase } from "./update";

export const LOCAL_UPDATE_CONFIRMATION_TITLE = "Rebase and build patched update?";

export const LOCAL_UPDATE_CONFIRMATION_MESSAGE =
  "This will rebase custom/local-customizations on upstream/main, preserve backups and stashed work, then build a patched installer. It will not install the official binary.";

export const LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL = "Rebase and build installer";

export function shouldConfirmLocalUpdate(localPatched: boolean, phase: UpdatePhase): boolean {
  return localPatched && (phase === "available" || phase === "error");
}
