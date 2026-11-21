import { describe, expect, it } from "vitest";
import type { Item } from "./App";
import { RECENT_TOOL_IMAGES_KEPT, trimOlderToolImages } from "./transcript-images";

const shot = (n: number, path: string | null = `/shots/${n}.png`): Item => ({
  kind: "images",
  id: n,
  images: [{ src: `data:image/png;base64,${n}`, ...(path ? { path } : {}) }],
});

const srcs = (items: Item[]): (string | undefined)[] =>
  items.flatMap((item) => (item.kind === "images" ? item.images.map((image) => image.src) : []));

describe("trimOlderToolImages", () => {
  it("keeps data only for the newest 12 path-backed images", () => {
    expect(RECENT_TOOL_IMAGES_KEPT).toBe(12);
    const items = Array.from({ length: 13 }, (_, i) => shot(i + 1));
    const trimmed = trimOlderToolImages(items);
    expect(trimmed[0]).toEqual({ kind: "images", id: 1, images: [{ path: "/shots/1.png" }] });
    expect(srcs(trimmed).slice(1)).toEqual(
      Array.from({ length: 12 }, (_, i) => `data:image/png;base64,${i + 2}`),
    );
    expect(trimmed.slice(1)).toEqual(items.slice(1));
    expect(trimmed[1]).toBe(items[1]);
  });

  it("counts every image inside a multi-image item, newest first", () => {
    const items: Item[] = [
      {
        kind: "images",
        id: 1,
        images: [
          { src: "data:a", path: "/a.png" },
          { src: "data:b", path: "/b.png" },
        ],
      },
      shot(2),
    ];
    expect(srcs(trimOlderToolImages(items, 2))).toEqual([
      undefined,
      "data:b",
      "data:image/png;base64,2",
    ]);
  });

  it("never trims images without a path", () => {
    const items = Array.from({ length: 20 }, (_, i) => shot(i + 1, null));
    expect(trimOlderToolImages(items)).toBe(items);
  });

  it("keeps an older image's data when a newer image reuses its path", () => {
    const items = [
      shot(1, "/same.png"),
      ...Array.from({ length: 12 }, (_, i) => shot(i + 2)),
      shot(14, "/same.png"),
    ];
    const trimmed = trimOlderToolImages(items);
    expect(trimmed[0]).toBe(items[0]);
    // The reused path doesn't count toward the 12, so shot 2 is the 13th and loses its data.
    expect(srcs(trimmed).slice(0, 3)).toEqual([
      "data:image/png;base64,1",
      undefined,
      "data:image/png;base64,3",
    ]);
  });

  it("leaves pasted user images and other items untouched", () => {
    const user: Item = {
      kind: "user",
      id: 100,
      text: "look",
      images: ["data:image/png;base64,pasted"],
    };
    const items = [user, ...Array.from({ length: 13 }, (_, i) => shot(i + 1))];
    const trimmed = trimOlderToolImages(items);
    expect(trimmed[0]).toBe(user);
    expect(srcs(trimmed)[0]).toBeUndefined();
  });

  it("returns the same array when nothing changes, including after an earlier trim", () => {
    const items = Array.from({ length: 13 }, (_, i) => shot(i + 1));
    const once = trimOlderToolImages(items);
    expect(trimOlderToolImages(once)).toBe(once);
    const few = [shot(1), shot(2)];
    expect(trimOlderToolImages(few)).toBe(few);
  });
});
