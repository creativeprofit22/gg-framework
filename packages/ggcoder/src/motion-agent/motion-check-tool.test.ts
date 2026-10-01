import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { StructuredToolResult } from "@kenkaiiii/gg-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findMotionBundle, type MotionBundle } from "../core/skills.js";
import { createMotionCheckTool, spotSampleTimes } from "./motion-check-tool.js";

const exec = promisify(execFile);
// Each test spawns real FFmpeg, ffprobe and Node processes. On the Windows CI runner a
// cold start has stretched a ~4 s test past 20 s, so give real headroom.
const MEDIA_TEST_MS = 60_000;
const runtimeReport = {
  ok: true,
  lint: { filesScanned: 1, errorCount: 0 },
  runtime: { errorCount: 0 },
  layout: { samples: [0.5], errorCount: 0 },
  contrast: { enabled: true, samples: [0.5], errorCount: 0 },
};
const summarySchema = z.object({
  technical: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  visual: z.string(),
});
function summary(result: string | StructuredToolResult): z.infer<typeof summarySchema> {
  if (typeof result === "string") return summarySchema.parse(JSON.parse(result));
  if (typeof result.content === "string") return summarySchema.parse(JSON.parse(result.content));
  const text = result.content.find((part) => part.type === "text");
  if (text?.type !== "text") throw new Error("Missing technical report");
  return summarySchema.parse(JSON.parse(text.text));
}
let root = "";
let bundle: MotionBundle;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-single-pass-"));
  const installed = await findMotionBundle();
  if (!installed) throw new Error("Missing Motion bundle");
  bundle = { ...installed, launcher: path.join(root, "runtime.mjs") };
  await fs.mkdir(path.join(root, "renders"));
  await fs.writeFile(path.join(root, "index.html"), "<div>fixture</div>");
  await setRuntime(runtimeReport);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function setRuntime(
  report: unknown,
  behaviour: { exitCode?: number; stderr?: string; hang?: boolean } = {},
): Promise<void> {
  const { exitCode = 0, stderr = "", hang = false } = behaviour;
  // Like the real launcher: on SIGTERM the CLI exits 0 without printing a report.
  const body = hang
    ? `process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);`
    : `process.stderr.write(${JSON.stringify(stderr)});
console.log(${JSON.stringify(JSON.stringify(report))});
process.exitCode = ${exitCode};`;
  await fs.writeFile(
    bundle.launcher,
    `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))}, JSON.stringify(process.argv.slice(2))+'\\n');
${body}`,
  );
}
function details(result: string | StructuredToolResult, name: string): string {
  const text =
    typeof result === "string"
      ? result
      : typeof result.content === "string"
        ? result.content
        : result.content.find((part) => part.type === "text")?.text;
  const parsed = z
    .object({ checks: z.array(z.object({ name: z.string(), details: z.string() })) })
    .parse(JSON.parse(text ?? ""));
  const found = parsed.checks.find((item) => item.name === name);
  if (!found) throw new Error(`Missing check ${name}`);
  return found.details;
}
async function render(audio?: "quiet" | "clipped", still = false): Promise<void> {
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    still
      ? "color=c=red:size=320x180:rate=24:duration=2"
      : "testsrc2=size=320x180:rate=24:duration=2",
    ...(audio
      ? [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=2",
          "-af",
          audio === "quiet" ? "volume=0.2" : "volume=20",
          "-c:a",
          "aac",
        ]
      : []),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "renders", "video.mp4"),
  ]);
}
type CheckInput = {
  slideshowRequested?: boolean;
  output?: string;
  spot?: boolean;
  project?: string;
};
async function check(
  extra: CheckInput = {},
  limits: { sourceCheckMs?: number; spotMaxFrames?: number } = {},
  tool = createMotionCheckTool(root, bundle, limits),
): Promise<string | StructuredToolResult> {
  return tool.execute(
    {
      project: ".",
      output: "renders/video.mp4",
      windows: [{ label: "Reveal", start: 0, end: 0.5 }],
      ...extra,
    },
    { signal: new AbortController().signal, toolCallId: "single-pass" },
  );
}
async function sourceCheckCalls(): Promise<number> {
  const log = path.join(root, "calls.jsonl");
  if (!(await fs.stat(log).catch(() => null))) return 0;
  return (await fs.readFile(log, "utf8")).split("\n").filter(Boolean).length;
}

describe("spot-check frame sampling", () => {
  it.each([
    {
      name: "every frame in a window",
      windows: [{ start: 0, end: 0.3 }],
      expected: [0, 0.1, 0.2, 0.3],
    },
    {
      name: "only frames the export contains",
      windows: [{ start: 0.05, end: 0.25 }],
      expected: [0.1, 0.2],
    },
    {
      name: "overlapping windows once",
      windows: [
        { start: 0, end: 0.2 },
        { start: 0.1, end: 0.3 },
      ],
      expected: [0, 0.1, 0.2, 0.3],
    },
    {
      name: "no instant past the last frame",
      windows: [{ start: 1.85, end: 2.5 }],
      expected: [1.9],
    },
  ])("samples $name", ({ windows, expected }) => {
    expect(spotSampleTimes(windows, 10, 2)).toEqual(expected);
  });
});

describe("Motion single-pass output check", { timeout: MEDIA_TEST_MS }, () => {
  it("runs one runtime check including lint and returns real images to the working agent", async () => {
    await render();
    const before = await fs.readFile(path.join(root, "renders", "video.mp4"));
    const result = await check();
    expect(summary(result).technical).toBe(true);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error(result);
    if (typeof result.content === "string") throw new Error("Expected image content");
    const images = result.content.filter((part) => part.type === "image");
    expect(images).toHaveLength(3);
    for (const image of images) expect(image.data).toMatch(/^\/9j\//);
    expect(summary(result).visual).toContain("No creative approval has been granted");
    const calls = (await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0] ?? "null")).toEqual([
      "check",
      await fs.realpath(root),
      "--json",
      "--contrast",
      "--at-transitions",
    ]);
    expect(await fs.readFile(path.join(root, "renders", "video.mp4"))).toEqual(before);
    expect(summary(result).checks.some((item) => item.name === "Audio levels")).toBe(false);
  });
  it.each(["quiet", "clipped"] as const)(
    "measures %s audio without imposing a generic mix target",
    async (audio) => {
      await render(audio);
      const result = summary(await check());
      expect(result.checks).toContainEqual({
        name: "Audio is finite and not clipping",
        ok: audio === "quiet",
      });
      expect(result.technical).toBe(audio === "quiet");
    },
  );
  it("honors configured FFmpeg and sibling ffprobe without PATH", async () => {
    await render("quiet");
    const located = await exec(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"]);
    const binary = located.stdout.trim().split(/\r?\n/)[0];
    if (!binary || !path.isAbsolute(binary)) throw new Error("Expected installed FFmpeg");
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", binary);
    vi.stubEnv("PATH", "");
    expect(summary(await check()).technical).toBe(true);
  });
  it.each([
    { ok: true },
    { ...runtimeReport, contrast: { enabled: false, samples: [], errorCount: 0 } },
  ])("rejects a success-looking incomplete runtime report: %j", async (report) => {
    await setRuntime(report);
    await render();
    const result = summary(await check());
    expect(result.technical).toBe(false);
    expect(result.checks).toContainEqual({ name: "Structured runtime report", ok: false });
  });
  it("shows the agent what a failing source check found, not just that it failed", async () => {
    const occluded = {
      code: "text_occluded",
      severity: "error",
      time: 12.48,
      selector: "div.f-name > span",
      text: "G",
      message: "Text is hidden beneath an opaque element.",
      fixHint: "Raise its stacking order above the covering element.",
    };
    const overlap = { code: "content_overlap", severity: "warning", message: "Overlap" };
    await setRuntime(
      {
        ...runtimeReport,
        ok: false,
        layout: {
          samples: [0.5, 1],
          errorCount: 2,
          warningCount: 2,
          findings: [occluded, overlap, { ...occluded, time: 13 }, overlap],
        },
      },
      {
        exitCode: 1,
        stderr:
          "[StaticGuard] Invalid HyperFrame contract: Font family used without @font-face declaration: archivo.\n",
      },
    );
    await render();
    const result = await check();
    expect(summary(result).technical).toBe(false);
    const found = details(result, "Runtime/layout/contrast (includes lint)");
    expect(found).toContain("found problems");
    expect(found).toContain("layout: 2 errors, 2 warnings (2 samples)");
    // The same problem on the same element is one line, with every time it was seen.
    expect(found).toContain("Errors (1 of 1 distinct problems listed)");
    expect(found).toContain('text_occluded div.f-name > span "G"');
    expect(found).toContain("[at 12.48s, 13s]");
    expect(found).toContain("Fix: Raise its stacking order");
    expect(found).toContain("layout content_overlap ×2");
    expect(found).toContain("without @font-face declaration: archivo");
    expect(found).not.toContain("Command failed");
  });
  it("lists where and when every distinct error occurs, not only the first few", async () => {
    const findings = Array.from({ length: 17 }, (_, index) => ({
      code: "text_occluded",
      severity: "error",
      time: index + 1,
      selector: `#el-${index + 1}`,
      text: "G",
      message: "Text is hidden beneath an opaque element.",
      fixHint: "Raise its stacking order above the covering element.",
    }));
    await setRuntime(
      { ...runtimeReport, ok: false, layout: { samples: [0.5, 1], errorCount: 17, findings } },
      { exitCode: 1 },
    );
    await render();
    const found = details(await check(), "Runtime/layout/contrast (includes lint)");
    expect(found).toContain("Errors (17 of 17 distinct problems listed)");
    expect(found).toContain('- layout text_occluded #el-15 "G": Text is hidden');
    // Later problems keep their location and time; only the repeated advice is dropped.
    expect(found).toContain('- layout text_occluded #el-16 "G" [at 16s]');
    expect(found).toContain('- layout text_occluded #el-17 "G" [at 17s]');
  });
  it("stops listing whole errors before the report cap and says how many it listed", async () => {
    const findings = Array.from({ length: 200 }, (_, index) => ({
      code: "text_occluded",
      severity: "error",
      time: index + 1,
      selector: `#scene-${index + 1} > ${"div.card-with-a-long-class-name > ".repeat(3)}span`,
      text: "Label",
      message: "Text is hidden beneath an opaque element.",
    }));
    await setRuntime(
      { ...runtimeReport, ok: false, layout: { samples: [0.5, 1], errorCount: 200, findings } },
      { exitCode: 1 },
    );
    await render();
    const found = details(await check(), "Runtime/layout/contrast (includes lint)");
    const listed = Number(/Errors \((\d+) of 200 distinct problems listed\)/.exec(found)?.[1]);
    expect(listed).toBeGreaterThan(15);
    expect(listed).toBeLessThan(200);
    expect(found.length).toBeLessThan(12_000);
    const lines = found.split("\n").filter((line) => line.startsWith("- layout"));
    expect(lines).toHaveLength(listed);
    for (const line of lines) expect(line).toMatch(/\[at \d+s\]$/);
  });
  it("spot-checks only the rendered frames inside the windows and never counts as delivery", async () => {
    await render();
    const result = await check({ spot: true });
    const calls = (await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    // The 24 fps fixture has 13 frames from 0 s to 0.5 s.
    expect(JSON.parse(calls[0] ?? "null")).toEqual([
      "check",
      await fs.realpath(root),
      "--json",
      "--contrast",
      "--at",
      "0,0.042,0.083,0.125,0.167,0.208,0.25,0.292,0.333,0.375,0.417,0.458,0.5",
    ]);
    const report = summary(result);
    expect(report.technical).toBe(false);
    expect(report.checks.filter((item) => !item.ok)).toEqual([
      { name: "Full-video source check", ok: false },
    ]);
    expect(details(result, "Full-video source check")).toContain(
      "audited the 13 rendered frames inside the windows only",
    );
    if (typeof result === "string" || typeof result.content === "string")
      throw new Error("Expected image content");
    const text = result.content.find((part) => part.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({ scope: "spot" });
  });
  it("rejects spot windows over the frame budget before running any check", async () => {
    await render();
    const result = await check({ spot: true }, { spotMaxFrames: 12 });
    expect(summary(result).technical).toBe(false);
    expect(JSON.parse(typeof result === "string" ? result : "{}")).toMatchObject({
      error: expect.stringContaining(
        "Spot windows cover 13 rendered frames; keep them to at most 12",
      ),
    });
    expect(await sourceCheckCalls()).toBe(0);
  });
  it("reuses a passing source check only while the project source is unchanged", async () => {
    // The launcher and its call log live outside this project, as in a real install.
    await fs.mkdir(path.join(root, "project"));
    await fs.writeFile(path.join(root, "project", "index.html"), "<div>fixture</div>");
    await render();
    const tool = createMotionCheckTool(root, bundle);
    const input = { project: "project" };
    expect(summary(await check(input, {}, tool)).technical).toBe(true);
    // A spot check neither reuses nor stands in for the full source check.
    expect(summary(await check({ ...input, spot: true }, {}, tool)).technical).toBe(false);
    expect(await sourceCheckCalls()).toBe(2);
    const again = await check(input, {}, tool);
    expect(summary(again).technical).toBe(true);
    expect(details(again, "Runtime/layout/contrast (includes lint)")).toMatch(/^Reused: /);
    expect(await sourceCheckCalls()).toBe(2);
    await fs.writeFile(path.join(root, "project", "index.html"), "<div>edited</div>");
    expect(summary(await check(input, {}, tool)).technical).toBe(true);
    expect(await sourceCheckCalls()).toBe(3);
  });
  it("does not reuse a failing source check", async () => {
    await fs.mkdir(path.join(root, "project"));
    await fs.writeFile(path.join(root, "project", "index.html"), "<div>fixture</div>");
    await setRuntime({ ...runtimeReport, ok: false }, { exitCode: 1 });
    await render();
    const tool = createMotionCheckTool(root, bundle);
    expect(summary(await check({ project: "project" }, {}, tool)).technical).toBe(false);
    expect(summary(await check({ project: "project" }, {}, tool)).technical).toBe(false);
    expect(await sourceCheckCalls()).toBe(2);
  });
  it("fails a source check that runs out of time instead of passing its empty output", async () => {
    await setRuntime(runtimeReport, { hang: true });
    await render();
    const result = await check({}, { sourceCheckMs: 1500 });
    expect(summary(result).technical).toBe(false);
    expect(summary(result).checks).toContainEqual({
      name: "Runtime/layout/contrast (includes lint)",
      ok: false,
    });
    expect(details(result, "Runtime/layout/contrast (includes lint)")).toContain(
      "Did not finish within 1.5 s",
    );
  });
  it.each([false, true])(
    "does not excuse frozen output without explicit slideshow intent (%s)",
    async (slideshowRequested) => {
      await render(undefined, true);
      expect(summary(await check({ slideshowRequested })).technical).toBe(slideshowRequested);
    },
  );
  it("rejects workspace path escapes before running any check", async () => {
    expect(summary(await check({ output: "../outside.mp4" })).technical).toBe(false);
    await expect(fs.access(path.join(root, "calls.jsonl"))).rejects.toThrow();
  });
  it("honors cancellation before launching processes", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createMotionCheckTool(root, bundle).execute(
        {
          project: ".",
          output: "renders/video.mp4",
          windows: [{ label: "Reveal", start: 0, end: 0.5 }],
        },
        {
          signal: controller.signal,
          toolCallId: "cancel",
        },
      ),
    ).rejects.toThrow("cancelled");
    await expect(fs.access(path.join(root, "calls.jsonl"))).rejects.toThrow();
  });
});
