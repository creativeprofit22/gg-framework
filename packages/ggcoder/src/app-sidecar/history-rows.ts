import { stat } from "node:fs/promises";
import path from "node:path";
import { readFileBounded } from "../tools/operations.js";
import { spawnedTasks } from "../tools/subagent-shared.js";
import { animatedPreview } from "../utils/image.js";

/**
 * The worker rows a restored transcript shows for one delegation call. A
 * refused spawn started no worker (live bug: a spawn blocked during a goal's
 * briefing came back after a restart as "critters didn't make it back").
 */
export function restoredWorkerRows(
  call: { readonly name: string; readonly args: Record<string, unknown> },
  resultIsError: boolean | null,
): Array<{ agentName: string | undefined; status: "done" | "error"; toolUseCount: number }> {
  const status = resultIsError ? ("error" as const) : ("done" as const);
  if (call.name === "spawn_agent") {
    if (resultIsError) return [];
    // One row per child: a batch call starts several.
    return spawnedTasks(call.args).map((spawn) => ({
      agentName: spawn.task_name ?? spawn.agent,
      status,
      toolUseCount: 0,
    }));
  }
  return [
    {
      agentName: typeof call.args.agent === "string" ? call.args.agent : undefined,
      status,
      toolUseCount: 0,
    },
  ];
}

/**
 * An animated preview for a restored generate_image GIF, read from its file:
 * the session only persists the first frame as a still, which would freeze it.
 * Null when the result is not a GIF or the file has gone.
 */
export async function restoredGifPreview(
  toolName: string | undefined,
  imgPath: string | undefined,
): Promise<string | null> {
  if (toolName !== "generate_image" || !imgPath) return null;
  if (path.extname(imgPath).toLowerCase() !== ".gif") return null;
  const info = await stat(imgPath).catch(() => null);
  if (!info?.isFile()) return null;
  // Reopening a chat re-renders every GIF in it; resize each file once.
  const key = `${imgPath}\0${info.mtimeMs}\0${info.size}`;
  const cached = gifPreviewCache.get(key);
  if (cached) return cached;
  const raw = await readFileBounded(imgPath).catch(() => null);
  if (!raw || raw.subarray(0, 4).toString("latin1") !== "GIF8") return null;
  const preview = await animatedPreview(raw);
  const src = `data:${preview.mediaType};base64,${preview.buffer.toString("base64")}`;
  gifPreviewCache.set(key, src);
  const oldest =
    gifPreviewCache.size > GIF_PREVIEW_CACHE_SIZE ? gifPreviewCache.keys().next() : null;
  if (oldest && !oldest.done) gifPreviewCache.delete(oldest.value);
  return src;
}

const GIF_PREVIEW_CACHE_SIZE = 32;
const gifPreviewCache = new Map<string, string>();
