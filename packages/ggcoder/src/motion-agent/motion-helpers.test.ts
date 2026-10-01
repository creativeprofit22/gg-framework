import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";

const run = promisify(execFile);

async function binPath(script: string): Promise<string> {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("motion bundle missing");
  return path.join(bundle.root, "bin", script);
}

/** Run a bundled helper with the current Node; resolves with exit code and output. */
async function runHelper(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [await binPath(script), ...args], {
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-helpers-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("score-synth", () => {
  const score = {
    bpm: 120,
    duration: 8,
    seed: 3,
    chords: ["Am", "F"],
    sections: [
      { name: "intro", from: 0, energy: 0.3 },
      { name: "drop", from: 4, energy: 1 },
    ],
    hits: [
      { beat: 2, sfx: "pop" },
      { bar: 3, sfx: "sting" },
    ],
  };

  it("renders identical music, sfx and a beat-aligned tempo map for the same score", async () => {
    const scorePath = path.join(tmp, "score.json");
    await fs.writeFile(scorePath, JSON.stringify(score));

    const first = await runHelper("score-synth.mjs", [scorePath, path.join(tmp, "a")]);
    const second = await runHelper("score-synth.mjs", [scorePath, path.join(tmp, "b")]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    for (const file of ["music.wav", "sfx.wav"]) {
      const a = await fs.readFile(path.join(tmp, "a", file));
      const b = await fs.readFile(path.join(tmp, "b", file));
      expect(a.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(a.length).toBeGreaterThan(48000 * 2 * 2 * 7);
      expect(a.equals(b)).toBe(true);
    }
    const map = JSON.parse(await fs.readFile(path.join(tmp, "a", "tempo-map.json"), "utf8")) as {
      beats: number[];
      bars: number[];
      hits: { t: number; sfx: string }[];
    };
    expect(map.beats.slice(0, 4)).toEqual([0, 0.5, 1, 1.5]);
    expect(map.bars.slice(0, 3)).toEqual([0, 2, 4]);
    expect(map.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ t: 1, sfx: "pop" }),
        expect.objectContaining({ t: 6, sfx: "sting" }),
      ]),
    );
  });

  it.each([
    [{ ...score, bpm: 10 }, "bpm"],
    [{ ...score, duration: 0 }, "duration"],
    [{ ...score, hits: [{ t: 1, sfx: "airhorn" }] }, "unknown sfx"],
  ])("rejects an invalid score with a clear message (%#)", async (bad, message) => {
    const scorePath = path.join(tmp, "bad.json");
    await fs.writeFile(scorePath, JSON.stringify(bad));

    const result = await runHelper("score-synth.mjs", [scorePath, path.join(tmp, "out")]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});

describe("motion-check rendered-pixel gate", () => {
  const progress = "frame=80\nout_time_us=10000000\nprogress=end\n";

  async function analyze(
    text: string,
    slideshowRequested = false,
    holds: unknown = [],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const script = `
      import { pathToFileURL } from 'node:url';
      const { parseMotionOutput } = await import(pathToFileURL(process.argv[1]).href);
      const { text, slideshowRequested, holds } = JSON.parse(process.argv[2]);
      const result = parseMotionOutput(text, slideshowRequested, holds);
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    `;
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          await binPath("motion-check.mjs"),
          JSON.stringify({ text, slideshowRequested, holds }),
        ],
        { timeout: 10_000 },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("accepts a complete moving-pixel decode without a DOM motion spec", async () => {
    const result = await analyze(progress);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      method: "rendered-pixels",
      samples: 80,
      duration: 10,
      visualReviewRequired: true,
    });
  });

  it("rejects a frozen opening even when the rest moves", async () => {
    const result = await analyze(
      "lavfi.freezedetect.freeze_start=0\nlavfi.freezedetect.freeze_duration=3\nlavfi.freezedetect.freeze_end=3\n" +
        progress,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      freezes: [{ start: 0, end: 3, duration: 3 }],
    });
  });

  it("rejects a frozen ending with no freeze_end event", async () => {
    const result = await analyze("lavfi.freezedetect.freeze_start=7\n" + progress);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      freezes: [{ start: 7, end: 10, duration: 3 }],
    });
  });

  it.each([
    "",
    "frame=0\nout_time_us=0\nprogress=end\n",
    "frame=80\nout_time_us=10000000\nprogress=continue\n",
    "frame=NaN\nout_time_us=10000000\nprogress=end\n",
    "lavfi.freezedetect.freeze_start=oops\n" + progress,
    "lavfi.freezedetect.freeze_start=20\n" + progress,
    "lavfi.freezedetect.freeze_duration=3\n" + progress,
    "lavfi.freezedetect.freeze_end=3\n" + progress,
    "frame=80\nout_time_us=1000000000\nprogress=end\n",
    JSON.stringify({ ok: true, motion: { enabled: false, samples: 0 } }),
  ])("rejects missing, truncated or malformed evidence (%#)", async (text) => {
    const result = await analyze(text);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("error");
  });

  it("allows an explicitly requested slideshow but never skipped analysis", async () => {
    const allowed = await analyze("lavfi.freezedetect.freeze_start=0\n" + progress, true);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({
      slideshowRequested: true,
      freezes: [{ start: 0, end: 10, duration: 10 }],
    });
    const skipped = await analyze("", true);
    expect(skipped.code).toBe(1);
  });

  it("accepts a declared reading pause and reports it without hiding pixel evidence", async () => {
    const hold = { start: 7, end: 10, reason: "Read the final phrase" };
    const result = await analyze("lavfi.freezedetect.freeze_start=7\n" + progress, false, [hold]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      holds: [hold],
      freezes: [{ start: 7, end: 10, duration: 3 }],
      unexpectedFreezes: [],
      visualReviewRequired: true,
    });
  });

  it("still rejects a freeze outside a declared hold", async () => {
    const result = await analyze("lavfi.freezedetect.freeze_start=5\n" + progress, false, [
      { start: 7, end: 10, reason: "Read the final phrase" },
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      unexpectedFreezes: [{ start: 5, end: 10, duration: 5 }],
    });
  });

  it.each([
    null,
    [{ start: 7, end: 10, reason: "" }],
    [{ start: 7, end: 10, reason: "  " }],
    [{ start: "7", end: 10, reason: "Read" }],
    [{ start: 7, end: 11, reason: "Read" }],
    [{ start: -1, end: 10, reason: "Read" }],
    [{ start: 0, end: 10, reason: "Everything is a hold" }],
    [{ start: 10, end: 7, reason: "Read" }],
    [{ start: 7, end: 10, reason: "Read", ignoreAll: true }],
    [
      { start: 6, end: 9, reason: "Read" },
      { start: 7, end: 10, reason: "Read" },
    ],
  ])("rejects malformed, unbounded or overlapping hold declarations (%#)", async (holds) => {
    const result = await analyze("lavfi.freezedetect.freeze_start=7\n" + progress, false, holds);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("error");
  });

  it("names a stale hold and where pixels actually freeze so the plan is fixed once", async () => {
    const stale = { start: 1, end: 2.5, reason: "Read the premise" };
    const kept = { start: 6, end: 10, reason: "Final payoff" };
    const result = await analyze("lavfi.freezedetect.freeze_start=5.5\n" + progress, false, [
      stale,
      kept,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "Stale hold declaration: no detected freeze overlaps its window",
      staleHolds: [stale],
      freezes: [{ start: 5.5, end: 10, duration: 4.5 }],
    });
  });

  it("rejects stale hold declarations and incomplete analysis even with holds", async () => {
    const holds = [{ start: 7, end: 10, reason: "Read the final phrase" }];
    for (const text of [progress, "frame=80\nout_time_us=10000000\nprogress=continue\n"]) {
      const result = await analyze(text, false, holds);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toHaveProperty("error");
    }
  });

  it.each([
    ["{", "JSON"],
    [" ".repeat(64 * 1024 + 1), "exceeds 64 KiB"],
    [JSON.stringify({ version: 2, holds: [] }), "Expected hold plan version 1"],
    [
      JSON.stringify({
        version: 1,
        videoSha256: "0".repeat(64),
        holds: [{ start: 7, end: 10, reason: "Read" }],
      }),
      "different render",
    ],
  ])("rejects invalid or wrong-render hold files before decoding (%#)", async (content, error) => {
    const video = path.join(tmp, "render.mp4");
    const holds = path.join(tmp, "holds.json");
    await fs.writeFile(video, "not decoded in this boundary test");
    await fs.writeFile(holds, content);
    // If validation accidentally reaches FFmpeg, Node cannot decode this input.
    // The assertion requires the specific pre-decode validation error instead.
    const result = await runHelper("motion-check.mjs", [video, "--holds", holds], {
      ...process.env,
      HYPERFRAMES_FFMPEG_PATH: process.execPath,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(error);
  });

  it("rejects missing files and the obsolete report/spec interface", async () => {
    const missing = await runHelper("motion-check.mjs", [path.join(tmp, "missing.mp4")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Motion verification failed");
    const obsolete = await runHelper("motion-check.mjs", ["check.json", "index.motion.json"]);
    expect(obsolete.code).toBe(1);
    expect(obsolete.stderr).toContain("usage: motion-check.mjs");
  });
});

describe("hyperframes launcher", () => {
  it("refuses skill installs so bundled skills never drift", async () => {
    const result = await runHelper("hyperframes.mjs", ["skills", "update"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("bundled with GG Motion");
  });

  it("runs the pinned CLI version the skills were bundled for", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");

    const result = await runHelper("hyperframes.mjs", ["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(bundle.version);
  });

  it("keeps the privacy opt-outs in the launcher source", async () => {
    const source = await fs.readFile(await binPath("hyperframes.mjs"), "utf8");

    expect(source).toContain('"--describe", "false"');
    expect(source).toContain('"--skip-vision"');
    expect(source).toContain("HYPERFRAMES_NO_TELEMETRY");
    // `add` would otherwise overwrite whatever the user had copied.
    expect(source).toContain('[...args, "--no-clipboard"]');
  });
});

describe("contact-sheet", () => {
  it("fails clearly when the frames folder is missing", async () => {
    const result = await runHelper("contact-sheet.mjs", [
      path.join(tmp, "nope"),
      path.join(tmp, "sheet.jpg"),
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Frames folder not found");
  });
});

describe("reveal", () => {
  type Reveal = { ok: boolean; revealed?: string; cmd?: string; args?: string[]; error?: string };
  const parse = (stdout: string): Reveal => JSON.parse(stdout) as Reveal;

  it.each([
    ["darwin", "open", (file: string) => ["-R", file]],
    ["win32", "explorer.exe", (file: string) => [`/select,"${file}"`]],
    ["linux", "xdg-open", (file: string) => [path.dirname(file)]],
  ])("selects a finished video in the %s file manager", async (platform, cmd, expected) => {
    // A space in the folder name, as in the real "GG Motion" workspace.
    const file = path.join(tmp, "GG Motion", "brag.mp4");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "");

    const result = await runHelper("reveal.mjs", [file, "--dry-run", "--platform", platform]);

    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toMatchObject({
      ok: true,
      revealed: file,
      cmd,
      args: expected(file),
    });
  });

  it("opens a folder itself rather than its parent", async () => {
    const result = await runHelper("reveal.mjs", [tmp, "--dry-run", "--platform", "darwin"]);

    expect(parse(result.stdout)).toMatchObject({ ok: true, cmd: "open", args: [tmp] });
  });

  it("reports a missing file instead of opening anything", async () => {
    const result = await runHelper("reveal.mjs", [path.join(tmp, "nope.mp4"), "--dry-run"]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout)).toMatchObject({ ok: false });
    expect(parse(result.stdout).error).toContain("Not found");
  });

  it("only accepts a platform override on a dry run", async () => {
    const result = await runHelper("reveal.mjs", [tmp, "--platform", "linux"]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout).error).toContain("only works with --dry-run");
  });
});

describe("fonts", () => {
  type FontsResult = {
    ok: boolean;
    error?: string;
    specimen?: string;
    families?: Array<{ family: string; use?: string }>;
    installed?: string[];
    head?: string;
  };
  const parse = (stdout: string): FontsResult => JSON.parse(stdout) as FontsResult;

  it("ships every listed family with its woff2 files and OFL license", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const manifest = JSON.parse(
      await fs.readFile(path.join(bundle.root, "fonts", "fonts.json"), "utf8"),
    ) as Array<{ family: string; dir: string; license: string; files: Array<{ file: string }> }>;

    expect(manifest.length).toBeGreaterThanOrEqual(12);
    for (const entry of manifest) {
      expect(entry.license).toBe("OFL-1.1");
      const license = await fs.readFile(
        path.join(bundle.root, "fonts", entry.dir, "OFL.txt"),
        "utf8",
      );
      expect(license).toContain("SIL Open Font License");
      for (const file of entry.files) {
        const bytes = await fs.readFile(path.join(bundle.root, "fonts", entry.dir, file.file));
        // woff2 magic number: every file must be a real font, not an HTML error page.
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      }
    }
    const list = parse((await runHelper("fonts.mjs", ["list"])).stdout);
    expect(list.families?.map((f) => f.family)).toEqual(manifest.map((f) => f.family));
    // Title, body and handwritten faces the product asked for, each with a usage hint.
    for (const family of ["Unbounded", "Sora", "Short Stack", "Finger Paint"]) {
      expect(list.families?.find((f) => f.family === family)?.use).toBeTruthy();
    }
    await expect(fs.access(list.specimen ?? "")).resolves.toBeUndefined();
  });

  it("installs chosen families into a project and keeps earlier ones", async () => {
    const first = await runHelper("fonts.mjs", ["add", tmp, "mona sans", "Fraunces"]);
    const second = await runHelper("fonts.mjs", ["add", tmp, "Martian Mono"]);

    expect(first.code).toBe(0);
    expect(parse(second.stdout).installed).toEqual(["Mona Sans", "Fraunces", "Martian Mono"]);
    // The page-ready block uses paths from the project folder and covers every installed family.
    const head = parse(second.stdout).head ?? "";
    expect(head).toMatch(/^<style>\n[\s\S]*\n<\/style>$/);
    expect(head).toContain('url("assets/fonts/fraunces/fraunces-italic.woff2")');
    for (const family of ["Mona Sans", "Fraunces", "Martian Mono"]) {
      expect(head).toContain(`font-family: "${family}";`);
    }
    const css = await fs.readFile(path.join(tmp, "assets", "fonts", "fonts.css"), "utf8");
    expect(css).toContain('font-family: "Mona Sans";');
    expect(css).toContain("font-stretch: 75% 125%;");
    expect(css).toContain('url("fraunces/fraunces-italic.woff2")');
    expect(css).toContain('font-family: "Martian Mono";');
    await expect(
      fs.access(path.join(tmp, "assets", "fonts", "mona-sans", "OFL.txt")),
    ).resolves.toBeUndefined();
  });

  it("rejects families outside the bundle instead of writing anywhere", async () => {
    const result = await runHelper("fonts.mjs", ["add", tmp, "../../etc"]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout).error).toContain("Unknown family");
    await expect(fs.access(path.join(tmp, "assets"))).rejects.toThrow();
  });
});

describe("three", () => {
  type ThreeResult = {
    ok: boolean;
    error?: string;
    version?: string;
    installed?: string;
    addons?: string[];
    importmap?: string;
  };
  const parse = (stdout: string): ThreeResult => JSON.parse(stdout) as ThreeResult;

  it("vendors a self-contained Three.js whose addon imports all resolve offline", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const root = path.join(bundle.root, "vendor", "three");
    const manifest = JSON.parse(await fs.readFile(path.join(root, "three.json"), "utf8")) as {
      version: string;
      addons: string[];
    };

    await expect(fs.readFile(path.join(root, "LICENSE"), "utf8")).resolves.toContain("MIT");
    const core = await fs.readFile(path.join(root, "build", "three.module.min.js"), "utf8");
    expect(core).toContain(manifest.version.replace(/^0\./, "").split(".")[0] ?? "");
    for (const addon of manifest.addons) {
      const file = path.join(root, "addons", addon);
      // Doc comments quote example imports (`three/addons/...`); only real
      // import statements matter.
      const source = (await fs.readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Addons may import only "three" (the importmap) or files that ship
      // beside them; anything else would fetch from the network or 404.
      for (const match of source.matchAll(
        /^\s*(?:import|export)\s+(?:[^;]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
      )) {
        const spec = match[1] ?? "";
        if (spec === "three" || spec === "three/webgpu" || spec === "three/tsl") {
          expect(spec, `${addon} imports ${spec}`).toBe("three");
          continue;
        }
        expect(spec.startsWith("."), `${addon} imports ${spec}`).toBe(true);
        await expect(
          fs.access(path.join(path.dirname(file), spec)),
          `${addon} → ${spec}`,
        ).resolves.toBeUndefined();
      }
    }
  });

  it("installs the library into a project with an importmap that points at it", async () => {
    const result = await runHelper("three.mjs", ["add", tmp]);
    const out = parse(result.stdout);

    expect(result.code).toBe(0);
    expect(out.version).toBe("0.181.2");
    expect(out.importmap).toContain('"three": "./assets/vendor/three/build/three.module.min.js"');
    expect(out.importmap).not.toMatch(/https?:/);
    for (const rel of ["build/three.module.min.js", "build/three.core.min.js", "LICENSE"]) {
      await expect(
        fs.access(path.join(tmp, "assets", "vendor", "three", rel)),
      ).resolves.toBeUndefined();
    }
    await expect(
      fs.access(path.join(tmp, "assets", "vendor", "three", "addons", "postprocessing", "Pass.js")),
    ).resolves.toBeUndefined();
  });

  it("refuses a missing project instead of creating one", async () => {
    const result = await runHelper("three.mjs", ["add", path.join(tmp, "nope")]);

    expect(result.code).not.toBe(0);
    expect(parse(result.stdout).error).toContain("Project folder not found");
  });
});
