#!/usr/bin/env node
// GG-authored bounded rendered evidence. One invocation covers one chapter.
// node review-frames.mjs <video> <new-output-folder> <windows.json>
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { mediaBinaries } from "./media-binaries.mjs";

const exec = promisify(execFile);
const MAX_BYTES = 16 * 1024 * 1024;
const contained = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};
export async function hashVideo(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}
const xml = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function reviewFrames(videoArg, outArg, windows, signal, range) {
  signal?.throwIfAborted();
  const video = await realpath(videoArg);
  const info = await stat(video);
  if (!info.isFile() || info.size > 2 * 1024 ** 3)
    throw new Error("Video must be a local file under 2 GiB");
  const root = path.dirname(video);
  const parent = await realpath(path.dirname(path.resolve(outArg)));
  const out = path.join(parent, path.basename(path.resolve(outArg)));
  if (
    !contained(path.dirname(path.resolve(videoArg)), path.resolve(outArg)) ||
    !contained(root, out) ||
    (parent !== root && !contained(root, parent))
  ) {
    throw new Error("Output must stay inside the video's real folder; no symlink escapes");
  }
  if (
    await lstat(out).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })
  )
    throw new Error("Output already exists");
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 12)
    throw new Error("Supply 1–12 action windows; batch longer films by chapter");
  const run = async (command, args) => {
    signal?.throwIfAborted();
    return exec(command, args, {
      signal,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      killSignal: "SIGKILL",
    });
  };
  const { ffmpeg, ffprobe } = await mediaBinaries();
  const { stdout } = await run(ffprobe, [
    "-protocol_whitelist",
    "file,pipe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate:format=duration",
    "-of",
    "json",
    video,
  ]);
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.[0];
  const duration = Number(probe.format?.duration);
  const [num, den] = String(stream?.avg_frame_rate).split("/").map(Number);
  const fps = num / den;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 3600 ||
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > 120 ||
    !Number.isInteger(stream?.width) ||
    !Number.isInteger(stream?.height) ||
    stream.width < 1 ||
    stream.height < 1 ||
    stream.width > 8192 ||
    stream.height > 8192
  ) {
    throw new Error(
      "Unsupported video metadata: at most 3600 seconds, 1–120 fps, up to 8192 pixels",
    );
  }
  const scope = range ?? { start: 0, end: duration };
  if (
    !Number.isFinite(scope.start) ||
    !Number.isFinite(scope.end) ||
    scope.start < 0 ||
    scope.end > duration ||
    scope.end <= scope.start ||
    scope.end - scope.start > 180
  )
    throw new Error("Specify a chapter range of at most 180 seconds within the video");
  for (const w of windows) {
    if (
      !w ||
      typeof w.label !== "string" ||
      w.label.length < 1 ||
      w.label.length > 80 ||
      !Number.isFinite(w.start) ||
      !Number.isFinite(w.end) ||
      w.start < scope.start ||
      w.end <= w.start ||
      w.end > scope.end ||
      w.end - w.start > 10 ||
      w.end - w.start < 2 / fps
    )
      throw new Error("Invalid action window (2 frames to 10 seconds, within video)");
  }
  const require = createRequire(import.meta.url);
  const sharp = createRequire(require.resolve("hyperframes/package.json"))("sharp");
  const hash = await hashVideo(video, signal);
  const overview = Array.from({ length: 8 }, (_, i) =>
    Math.max(
      scope.start,
      Math.min(scope.end - 1 / fps, scope.start + ((scope.end - scope.start) * i) / 7),
    ),
  );
  const requests = [
    { kind: "overview", label: "overview", times: overview },
    { kind: "phone", label: "phone", times: overview },
  ];
  for (const w of windows) {
    // Consecutive frames at the start, centre and end, not isolated key poses.
    const times =
      w.end - w.start < 4 / fps
        ? Array.from(
            { length: Math.max(2, Math.floor((w.end - w.start) * fps + 0.000001)) },
            (_, i) => w.start + i / fps,
          )
        : [
            ...new Set(
              [w.start, (w.start + w.end) / 2 - 1 / fps, w.end - 2 / fps].flatMap((t) => [
                t,
                t + 1 / fps,
              ]),
            ),
          ].sort((a, b) => a - b);
    requests.push({ kind: "action", label: w.label, times });
  }
  await mkdir(out); // exclusive ownership; cleanup only this newly created directory
  try {
    // Decode the whole stream so a truncated tail cannot receive a valid manifest.
    await run(ffmpeg, [
      "-v",
      "error",
      "-xerror",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      video,
      "-map",
      "0:v:0",
      "-an",
      "-f",
      "null",
      "-",
    ]);
    let bytes = 0;
    const pages = [];
    // Overview, phone and action sheets share timestamps. Decode each once when
    // it fits the per-invocation cache; keep memory bounded independently of video size.
    const decodedFrames = new Map();
    let cachedBytes = 0;
    const sampleW = 390;
    const sampleH = Math.min(
      640,
      Math.max(64, Math.round((sampleW * stream.height) / stream.width)),
    );
    for (const [index, request] of requests.entries()) {
      signal?.throwIfAborted();
      const cellW = request.kind === "phone" ? 390 : 384;
      const cellH = Math.min(640, Math.max(64, Math.round((cellW * stream.height) / stream.width)));
      const cols = 4;
      const width = cellW * cols;
      const height = Math.ceil(request.times.length / cols) * (cellH + 28);
      const composites = [];
      for (const [i, time] of request.times.entries()) {
        const key = time.toFixed(6);
        let decoded = decodedFrames.get(key);
        if (!decoded) {
          const { stdout } = await exec(
            ffmpeg,
            [
              "-v",
              "error",
              "-xerror",
              "-nostdin",
              "-protocol_whitelist",
              "file,pipe",
              "-ss",
              key,
              "-i",
              video,
              "-frames:v",
              "1",
              "-vf",
              `scale=${sampleW}:${sampleH}:force_original_aspect_ratio=decrease,pad=${sampleW}:${sampleH}:(ow-iw)/2:(oh-ih)/2`,
              "-f",
              "image2pipe",
              "-vcodec",
              "png",
              "pipe:1",
            ],
            {
              signal,
              timeout: 15_000,
              maxBuffer: 2 * 1024 * 1024,
              encoding: "buffer",
              windowsHide: true,
              killSignal: "SIGKILL",
            },
          );
          decoded = stdout;
          if (decoded.length === 0) throw new Error("Missing decoded frame");
          if (cachedBytes + decoded.length <= MAX_BYTES) {
            decodedFrames.set(key, decoded);
            cachedBytes += decoded.length;
          }
        }
        const pixels =
          cellW === sampleW && cellH === sampleH
            ? decoded
            : await sharp(decoded)
                .resize(cellW, cellH, { fit: "contain", background: "#000" })
                .png()
                .toBuffer();
        const x = (i % cols) * cellW;
        const y = Math.floor(i / cols) * (cellH + 28);
        composites.push({ input: pixels, left: x, top: y });
        composites.push({
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="28"><text x="4" y="20" font-family="sans-serif" font-size="14" fill="white">${time.toFixed(3)}s · ${xml(Array.from(request.label).slice(0, 30).join(""))}${request.label.length > 30 ? "…" : ""}</text></svg>`,
          ),
          left: x,
          top: y + cellH,
        });
      }
      const image = await sharp({ create: { width, height, channels: 3, background: "#171717" } })
        .composite(composites)
        .jpeg({ quality: 82 })
        .toBuffer();
      bytes += image.length;
      if (bytes > MAX_BYTES) throw new Error("Evidence exceeds 16 MiB; use smaller chapters");
      const file = `${String(index).padStart(2, "0")}-${request.kind}.jpg`;
      await writeFile(path.join(out, file), image, { flag: "wx", signal });
      pages.push({
        ...request,
        file,
        width,
        height,
        sha256: createHash("sha256").update(image).digest("hex"),
      });
    }
    if ((await hashVideo(video, signal)) !== hash)
      throw new Error("Video changed during extraction");
    const manifest = {
      version: 1,
      range: scope,
      video: { file: path.basename(video), sha256: hash, duration, fps },
      windows,
      pages,
    };
    await writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      signal,
    });
    return manifest;
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const [video, out, config] = process.argv.slice(2);
    if (!video || !out || !config)
      throw new Error("usage: review-frames.mjs <video> <new-output-folder> <windows.json>");
    if ((await stat(config)).size > 16_384) throw new Error("Window config too large");
    const data = JSON.parse(await readFile(config, "utf8"));
    const manifest = await reviewFrames(
      video,
      out,
      Array.isArray(data) ? data : data.windows,
      controller.signal,
      Array.isArray(data) ? undefined : data.range,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, pages: manifest.pages.length, hash: manifest.video.sha256 })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Evidence extraction failed"}\n`,
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
