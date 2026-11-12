import type { Item } from "./App";

/** Newest path-backed tool images per pane that keep their data in memory. */
export const RECENT_TOOL_IMAGES_KEPT = 12;

/**
 * Drops the data of older tool images that have a file path, so long chats
 * don't hold every screenshot. Those images reload from `path` when shown.
 * Images without a path keep their data (it is the only copy), and an older
 * image whose path a newer image reuses keeps its data too: the file on disk
 * now holds the newer picture. Returns the same array when nothing changes.
 */
export function trimOlderToolImages(items: Item[], keep = RECENT_TOOL_IMAGES_KEPT): Item[] {
  const seenPaths = new Set<string>();
  let counted = 0;
  let next: Item[] | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "images") continue;
    let images: typeof item.images | null = null;
    for (let j = item.images.length - 1; j >= 0; j--) {
      const image = item.images[j];
      if (!image?.path || seenPaths.has(image.path)) continue;
      seenPaths.add(image.path);
      counted++;
      if (counted <= keep || image.src === undefined) continue;
      images ??= [...item.images];
      images[j] = { path: image.path };
    }
    if (!images) continue;
    next ??= [...items];
    next[i] = { ...item, images };
  }
  return next ?? items;
}
