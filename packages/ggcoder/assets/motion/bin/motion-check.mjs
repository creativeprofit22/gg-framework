#!/usr/bin/env node
// Check decoded video pixels, not DOM geometry: works for HTML, canvas and WebGL.
// A freeze detector is not a creative-quality score. Review choreography too.
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ffmpegBinary } from "./media-binaries.mjs";

const run = promisify(execFile);

/** Parse only completed FFmpeg progress + freezedetect metadata; never infer a pass from silence. */
export function parseMotionOutput(text, slideshowRequested = false, holds = []) {
  const invalid = () => ({
    ok: false,
    error: "Incomplete or malformed pixel analysis; motion is unverified",
  });
  if (typeof text !== "string" || typeof slideshowRequested !== "boolean") return invalid();
  let samples = 0;
  let duration = 0;
  let complete = false;
  let start = null;
  const freezes = [];
  for (const line of text.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key === "progress") {
      complete = value === "end";
      continue;
    }
    if (
      ![
        "frame",
        "out_time_us",
        "lavfi.freezedetect.freeze_start",
        "lavfi.freezedetect.freeze_end",
        "lavfi.freezedetect.freeze_duration",
      ].includes(key)
    )
      continue;
    const number = Number(value);
    if (!value || !Number.isFinite(number) || number < 0) return invalid();
    if (key === "frame") {
      if (!Number.isInteger(number) || number < samples) return invalid();
      samples = number;
    } else if (key === "out_time_us") {
      if (number / 1e6 < duration) return invalid();
      duration = number / 1e6;
    } else if (key === "lavfi.freezedetect.freeze_start") {
      if (start !== null) return invalid();
      start = number;
    } else if (key === "lavfi.freezedetect.freeze_duration") {
      if (start === null || number < 1) return invalid();
    } else if (key === "lavfi.freezedetect.freeze_end") {
      if (start === null || number < start) return invalid();
      freezes.push({ start, end: number, duration: number - start });
      start = null;
    }
  }
  if (!complete || samples < 2 || duration <= 0 || Math.abs(samples / 8 - duration) > 0.25)
    return invalid();
  if (start !== null) freezes.push({ start, end: duration, duration: duration - start });
  if (freezes.some((freeze) => freeze.duration < 1 || freeze.end > duration + 0.125))
    return invalid();
  // Hold declarations are narrow exceptions, never a substitute for decoding.
  // One sample of tolerance accounts for the fixed 8fps analysis grid.
  const tolerance = 1 / 8;
  let previousEnd = 0;
  let heldDuration = 0;
  if (!Array.isArray(holds) || holds.length > 128 || (slideshowRequested && holds.length))
    return { ok: false, error: "Invalid hold declarations" };
  for (const hold of holds) {
    if (
      !hold ||
      typeof hold !== "object" ||
      Array.isArray(hold) ||
      Object.keys(hold).some((key) => !["start", "end", "reason"].includes(key)) ||
      !Number.isFinite(hold.start) ||
      !Number.isFinite(hold.end) ||
      hold.start < previousEnd ||
      hold.end <= hold.start ||
      hold.end > duration ||
      typeof hold.reason !== "string" ||
      !hold.reason.trim() ||
      hold.reason.length > 500
    )
      return {
        ok: false,
        error: "Holds need ordered, non-overlapping in-range times and a reason",
      };
    previousEnd = hold.end;
    heldDuration += hold.end - hold.start;
  }
  if (heldDuration >= duration - tolerance)
    return {
      ok: false,
      error:
        "Holds cannot exempt the entire video; explicitly requested slideshows use their own mode",
    };
  const staleHolds = holds.filter(
    (hold) => !freezes.some((freeze) => freeze.end > hold.start && freeze.start < hold.end),
  );
  // Name the stale holds and where pixels actually freeze, so the plan is fixed in one
  // step instead of guessed again against another full check.
  if (staleHolds.length)
    return {
      ok: false,
      error: "Stale hold declaration: no detected freeze overlaps its window",
      staleHolds,
      freezes,
    };
  const unexpectedFreezes = freezes.filter(
    (freeze) =>
      !holds.some(
        (hold) => freeze.start >= hold.start - tolerance && freeze.end <= hold.end + tolerance,
      ),
  );
  return {
    ok: slideshowRequested || unexpectedFreezes.length === 0,
    method: "rendered-pixels",
    samples,
    duration,
    freezes,
    holds,
    unexpectedFreezes,
    slideshowRequested,
    visualReviewRequired: true,
  };
}

async function videoHash(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function readHoldPlan(file, signal) {
  // Bound reads even if a local file grows between stat and read.
  const handle = await open(file, "r");
  try {
    signal.throwIfAborted();
    if (!(await handle.stat()).isFile()) throw new Error("Expected a local hold-plan file");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === bytes.length) throw new Error("Hold plan exceeds 64 KiB");
    const plan = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (
      !plan ||
      typeof plan !== "object" ||
      Array.isArray(plan) ||
      plan.version !== 1 ||
      Object.keys(plan).some((key) => !["version", "videoSha256", "holds"].includes(key)) ||
      typeof plan.videoSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(plan.videoSha256) ||
      !Array.isArray(plan.holds) ||
      !plan.holds.length
    )
      throw new Error("Expected hold plan version 1 with videoSha256 and nonempty holds");
    return plan;
  } finally {
    await handle.close();
  }
}

async function main() {
  const [video, option, holdFile, ...extra] = process.argv.slice(2);
  if (
    !video ||
    extra.length ||
    (option === "--holds" ? !holdFile : holdFile || (option && option !== "--slideshow-requested"))
  ) {
    throw new Error(
      "usage: motion-check.mjs <rendered-video> [--holds <holds.json> | --slideshow-requested]",
    );
  }
  const file = resolve(video);
  if (!(await stat(file)).isFile()) throw new Error("Expected a local rendered video file");
  const binary = await ffmpegBinary();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const started = performance.now();
  try {
    const plan = holdFile ? await readHoldPlan(resolve(holdFile), controller.signal) : null;
    const videoSha256 = await videoHash(file, controller.signal);
    if (plan && plan.videoSha256 !== videoSha256)
      throw new Error(
        "Hold plan belongs to a different render; review this file before updating it",
      );
    const { stdout } = await run(
      binary,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        "fps=8,scale=320:180,freezedetect=n=0.001:d=1,metadata=mode=print:file=-",
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "null",
        "-",
      ],
      {
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        signal: controller.signal,
      },
    );
    if ((await videoHash(file, controller.signal)) !== videoSha256)
      throw new Error("Video changed during analysis; motion is unverified");
    const result = parseMotionOutput(stdout, option === "--slideshow-requested", plan?.holds ?? []);
    process.stdout.write(
      `${JSON.stringify({ ...result, file, videoSha256, elapsedMs: Math.round(performance.now() - started) })}\n`,
    );
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Motion verification failed: ${error instanceof Error ? error.message : "invalid input"}\n`,
    );
    process.exitCode = 1;
  }
}
