import type { UpdatePhase } from "./update";

export const LOCAL_UPDATE_CONFIRMATION_TITLE = "Merge and build patched update?";

export const LOCAL_UPDATE_CONFIRMATION_MESSAGE =
  "This will create a backup of commits and dirty work, merge upstream/main into custom/local-customizations without rewriting existing local commits, restore dirty work, verify the local fork, run checks, and build a patched installer. It will not install the official binary or push.";

export const LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL = "Merge and build installer";

export const LOCAL_UPDATE_SUMMARY_LABEL =
  "Explain what changed — and why — with my connected AI provider.";

export const LOCAL_UPDATE_SUMMARY_DISCLOSURE =
  "This sends bounded excerpts from the resolved code changes. The update still works without it.";

export function shouldConfirmLocalUpdate(localPatched: boolean, phase: UpdatePhase): boolean {
  return localPatched && (phase === "available" || phase === "error");
}
