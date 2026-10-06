import { describe, expect, it } from "vitest";
import { acpToolImages } from "./acp-images.js";

const image = (data = "QUJD", mediaType = "image/png") => ({ type: "image", mediaType, data });

describe("ACP tool images", () => {
  it("maps persisted image blocks and live desktop previews to standard ACP", () => {
    const expected = [
      { type: "content", content: { type: "image", mimeType: "image/png", data: "QUJD" } },
    ];
    expect(acpToolImages([image()])).toEqual(expected);
    expect(
      acpToolImages(undefined, { imagePreviews: [{ mediaType: "image/png", base64: "QUJD" }] }),
    ).toEqual(expected);
    expect(
      acpToolImages([image(), image()], {
        imagePreviews: [{ mediaType: "image/png", base64: "QUJD" }],
      }),
    ).toEqual(expected);
  });

  it("does not interpret arbitrary text, paths or URLs as image data", () => {
    expect(acpToolImages("/tmp/private.png")).toEqual([]);
    expect(acpToolImages(undefined, { imagePreviews: [{ path: "/tmp/private.png" }] })).toEqual([]);
    expect(
      acpToolImages([{ type: "resource_link", uri: "https://example.com/private.png" }]),
    ).toEqual([]);
  });

  it("rejects malformed content and unsupported formats without throwing", () => {
    for (const value of [null, undefined, 1, "bad", {}, [null, 7, {}]]) {
      expect(acpToolImages(value, { imagePreviews: value })).toEqual([]);
    }
    for (const data of ["", "not base64", "A===", "AAAA=AAA", "QUJ", 123, null]) {
      expect(acpToolImages([{ ...image(), data }])).toEqual([]);
    }
    expect(acpToolImages([image("QUJD", "image/svg+xml")])).toEqual([]);
    expect(acpToolImages([image("QUJD", "text/html")])).toEqual([]);
  });

  it("caps aggregate encoded bytes, skips oversized entries, and retains later valid images", () => {
    const max = 8 * 1024 * 1024;
    expect(acpToolImages([image("A".repeat(max)), image("QUJD")])).toHaveLength(1);
    expect(acpToolImages([image("A".repeat(max + 4)), image()])).toEqual(acpToolImages([image()]));
    expect(acpToolImages([image("A".repeat(max - 4)), image()])).toHaveLength(2);
  });

  it("caps image count even for tiny valid payloads", () => {
    const images = Array.from({ length: 20 }, (_, n) =>
      image(Buffer.from(`image-${n}`).toString("base64")),
    );
    const result = acpToolImages(images);
    expect(result).toHaveLength(16);
    expect(result.at(-1)!.content.data).toBe(images[15]!.data);
  });
});
