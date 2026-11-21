// Shared installed-tool lookup for Motion's pixel, frame and audio checks.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function installedBinary(name, preferredFolders = []) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const folders = [
    ...preferredFolders,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const folder of folders) {
    const candidate = resolve(join(folder, executable));
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try the next installed location; never install or download. */
    }
  }
  throw new Error(
    `${name} is missing; use hf doctor to locate it or install it beside HYPERFRAMES_FFMPEG_PATH`,
  );
}

export async function ffmpegBinary() {
  const override = process.env.HYPERFRAMES_FFMPEG_PATH?.trim();
  return override ? resolve(override) : installedBinary("ffmpeg");
}

export async function mediaBinaries() {
  const ffmpeg = await ffmpegBinary();
  const ffprobe = await installedBinary("ffprobe", [dirname(ffmpeg)]);
  return { ffmpeg, ffprobe };
}

// The session host uses this tiny CLI to share lookup with the shipped helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await mediaBinaries()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Media tools unavailable");
    process.exitCode = 1;
  }
}
