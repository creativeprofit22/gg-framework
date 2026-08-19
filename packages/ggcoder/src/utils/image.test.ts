import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({ execFileAsync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = vi.fn(actual.execFile);
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: mocks.execFileAsync,
  });
  return { ...actual, execFile };
});

import { boundedSize, fitsVisualBudget, shrinkToFit } from "./image.js";

const PATCH = 28;
const MAX_PATCHES = 1568;
const MAX_EDGE = 1568;

function patchArea(width: number, height: number): number {
  return (width * height) / (PATCH * PATCH);
}

/** Solid-colour PNG of exact dimensions — cheap to encode, real bytes for sharp. */
function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 32, g: 64, b: 128, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

describe("boundedSize", () => {
  const cases: Array<{
    name: string;
    input: [number, number];
    expected: [number, number];
  }> = [
    {
      name: "1280x800 laptop screenshot is already inside the budget",
      input: [1280, 800],
      expected: [1280, 800],
    },
    {
      name: "2000x2000 square shrinks to the patch budget",
      input: [2000, 2000],
      expected: [1108, 1108],
    },
    { name: "1x1 survives", input: [1, 1], expected: [1, 1] },
    { name: "1568x1 is exactly at the edge cap", input: [1568, 1], expected: [1568, 1] },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(boundedSize(input[0], input[1])).toEqual({ width: expected[0], height: expected[1] });
    });
  }

  it("2560x1600 stays within 1568 patches", () => {
    const { width, height } = boundedSize(2560, 1600);
    expect(patchArea(width, height)).toBeLessThanOrEqual(MAX_PATCHES);
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_EDGE);
    // aspect preserved within a pixel of rounding
    expect(Math.abs(width / height - 2560 / 1600)).toBeLessThan(0.01);
  });

  it("caps a 3000x400 panorama at 1568 on the long edge", () => {
    // Well inside the patch budget (1.2 MP) — only the per-side cap binds here.
    expect(patchArea(3000, 400)).toBeLessThanOrEqual(MAX_PATCHES);
    expect(boundedSize(3000, 400)).toEqual({ width: 1568, height: 209 });
  });

  it("returns the largest fitting size, not merely a fitting one", () => {
    for (const [w, h] of [
      [2000, 2000],
      [2560, 1600],
      [4000, 3000],
      [800, 5000],
    ] as Array<[number, number]>) {
      const { width, height } = boundedSize(w, h);
      expect(fitsVisualBudget(width, height)).toBe(true);
      // One pixel more on the long edge must break the budget or hit the cap.
      const landscape = w >= h;
      const long = landscape ? width : height;
      expect(long).toBeGreaterThan(0);
      if (long < MAX_EDGE) {
        const nextLong = long + 1;
        const ratio = landscape ? h / w : w / h;
        const nextShort = Math.max(1, Math.round(nextLong * ratio));
        const next = landscape
          ? { width: nextLong, height: nextShort }
          : { width: nextShort, height: nextLong };
        expect(fitsVisualBudget(next.width, next.height)).toBe(false);
      }
    }
  });

  it("leaves non-finite or sub-pixel input alone", () => {
    expect(boundedSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(boundedSize(Number.NaN, 10)).toEqual({ width: Number.NaN, height: 10 });
  });
});

describe("fitsVisualBudget", () => {
  it("rejects anything past the per-side cap even at tiny area", () => {
    expect(fitsVisualBudget(1569, 1)).toBe(false);
    expect(fitsVisualBudget(1568, 1)).toBe(true);
  });

  it("rejects anything past the patch budget", () => {
    expect(fitsVisualBudget(1108, 1108)).toBe(true);
    expect(fitsVisualBudget(1109, 1109)).toBe(false);
  });
});

describe("shrinkToFit", () => {
  afterEach(() => {
    mocks.execFileAsync.mockReset();
  });
  it("returns a 1280x800 PNG byte-identical to the input", async () => {
    const original = await makePng(1280, 800);
    const { buffer, mediaType } = await shrinkToFit(original, "image/png");
    expect(mediaType).toBe("image/png");
    expect(buffer.equals(original)).toBe(true);
  });

  it("downscales a 2000x2000 PNG to 1108x1108 and keeps it a PNG", async () => {
    const { buffer, mediaType } = await shrinkToFit(await makePng(2000, 2000), "image/png");
    expect(mediaType).toBe("image/png");
    const meta = await sharp(buffer).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 1108, height: 1108 });
    expect(meta.format).toBe("png");
  });

  it("brings a 2560x1600 screenshot inside the patch budget", async () => {
    const { buffer } = await shrinkToFit(await makePng(2560, 1600), "image/png");
    const meta = await sharp(buffer).metadata();
    expect(patchArea(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MAX_PATCHES);
  });

  it("caps a 3000x400 panorama at the long-edge limit", async () => {
    const { buffer } = await shrinkToFit(await makePng(3000, 400), "image/png");
    const meta = await sharp(buffer).metadata();
    // sharp's fit: "inside" preserves the exact source aspect, so the long edge
    // can land a pixel under the target — it must never land over it.
    expect(meta.width).toBeLessThanOrEqual(MAX_EDGE);
    expect(meta.width).toBeGreaterThan(MAX_EDGE - 4);
    expect(patchArea(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MAX_PATCHES);
  });

  it("leaves a 1x1 image untouched", async () => {
    const original = await makePng(1, 1);
    const { buffer } = await shrinkToFit(original, "image/png");
    expect(buffer.equals(original)).toBe(true);
  });

  it("transcodes AVIF bytes mislabeled as JPEG into a provider-supported PNG", async () => {
    const avif = await sharp({
      create: {
        width: 24,
        height: 16,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    })
      .avif()
      .toBuffer();

    const { buffer, mediaType } = await shrinkToFit(avif, "image/jpeg");

    expect(mediaType).toBe("image/png");
    expect(buffer.equals(avif)).toBe(false);
    expect((await sharp(buffer).metadata()).format).toBe("png");
  });

  it("falls back to bounded argv-based ffmpeg and cleans its temp input", async () => {
    const unsupported = Buffer.from("valid image bytes unsupported by sharp");
    const png = await makePng(32, 24);
    let tempInputPath = "";
    mocks.execFileAsync.mockImplementationOnce(
      async (file: string, args: string[], options: Record<string, unknown>) => {
        expect(file).toBe("ffmpeg");
        expect(args).toContain("-nostdin");
        expect(args).toContain("-frames:v");
        expect(args.at(-1)).toBe("pipe:1");
        expect(options).toMatchObject({
          encoding: "buffer",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 15_000,
          windowsHide: true,
        });
        tempInputPath = args[args.indexOf("-i") + 1] ?? "";
        expect(await fs.readFile(tempInputPath)).toEqual(unsupported);
        return { stdout: png, stderr: Buffer.alloc(0) };
      },
    );

    const result = await shrinkToFit(unsupported, "image/jpeg");

    expect(result.mediaType).toBe("image/png");
    expect((await sharp(result.buffer).metadata()).format).toBe("png");
    await expect(fs.stat(tempInputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a clear failure when ffmpeg is unavailable", async () => {
    const missingError = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    mocks.execFileAsync.mockRejectedValueOnce(missingError);

    await expect(shrinkToFit(Buffer.from("unsupported"), "image/jpeg")).rejects.toThrow(
      /ffmpeg is not installed/,
    );
  });

  it("reports ffmpeg decode failures and cleans its temp input", async () => {
    let tempInputPath = "";
    mocks.execFileAsync.mockImplementationOnce(async (_file: string, args: string[]) => {
      tempInputPath = args[args.indexOf("-i") + 1] ?? "";
      throw new Error("decoder rejected input");
    });

    await expect(shrinkToFit(Buffer.from("unsupported"), "image/jpeg")).rejects.toThrow(
      /ffmpeg image transcode failed: decoder rejected input/,
    );
    await expect(fs.stat(tempInputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the alpha channel rather than flattening to JPEG", async () => {
    const transparent = await sharp({
      create: {
        width: 2000,
        height: 2000,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const { buffer, mediaType } = await shrinkToFit(transparent, "image/png");
    expect(mediaType).toBe("image/png");
    const meta = await sharp(buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });
});
