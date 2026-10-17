import type { UpdateInfo } from "./update";

/**
 * Upstream's footer "update ready" banner. The Local Fork keeps the official
 * updater disabled (local updates run through the guarded source-merge flow on
 * the home screen), so this banner is deliberately inert: it never fetches and
 * never renders an update prompt, whatever phase it is handed.
 */
export function UpdateBanner(_props: {
  appUpdate: Pick<UpdateInfo, "phase" | "version" | "progress" | "install">;
}): null {
  return null;
}
