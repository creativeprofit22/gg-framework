import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, TextContent, ImageContent, VideoContent } from "@kenkaiiii/gg-ai";
import type { ImageAttachment } from "../utils/image.js";
import { VIDEO_MEDIA_TYPES } from "../utils/image.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import type { CustomCommand } from "../core/custom-commands.js";

export function routePromptCommandInput(
  input: string,
  promptCommands = PROMPT_COMMANDS,
  customCommands: Pick<CustomCommand, "name" | "prompt">[] = [],
): { cmdName: string; cmdArgs: string; promptText: string; fullPrompt: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(" ");
  const cmdName = parts[0];
  const cmdArgs = parts.slice(1).join(" ").trim();
  const builtinCmd = promptCommands.find((c) => c.name === cmdName || c.aliases.includes(cmdName));
  const customCmd = !builtinCmd ? customCommands.find((c) => c.name === cmdName) : undefined;
  const promptText = builtinCmd?.prompt ?? customCmd?.prompt;
  if (!promptText) return null;
  return {
    cmdName,
    cmdArgs,
    promptText,
    fullPrompt: cmdArgs ? `${promptText}\n\n## User Instructions\n\n${cmdArgs}` : promptText,
  };
}

/**
 * Resolve a usable on-disk path for a video attachment. Prefers the original
 * file path (set for any path-based attachment, works at any size). Falls back
 * to persisting the in-memory base64 to a temp file for attachments that have
 * no path (e.g. clipboard). Returns null if neither is available.
 */
function resolveVideoPath(img: ImageAttachment): string | null {
  if (img.filePath) return img.filePath;
  if (!img.data) return null;
  const ext =
    Object.entries(VIDEO_MEDIA_TYPES).find(([, mt]) => mt === img.mediaType)?.[0] ?? ".mp4";
  // os.tmpdir(), never a hardcoded /tmp: Windows has no /tmp and this write
  // would throw, silently dropping the video for no-vision models.
  const tmpPath = path.join(os.tmpdir(), `ggcoder-video-${Date.now()}${ext}`);
  try {
    writeFileSync(tmpPath, Buffer.from(img.data, "base64"));
    return tmpPath;
  } catch {
    return null;
  }
}

export function buildUserContentWithAttachments(
  text: string,
  inputImages: ImageAttachment[],
  modelSupportsImages: boolean,
  modelSupportsVideo: boolean,
  provider?: Provider,
): string | (TextContent | ImageContent | VideoContent)[] {
  if (inputImages.length === 0) return text;

  const parts: (TextContent | ImageContent | VideoContent)[] = [];
  if (text) {
    parts.push({ type: "text", text });
  }

  for (const img of inputImages) {
    if (img.kind === "text") {
      parts.push({
        type: "text",
        text: `<file name="${img.fileName}">\n${img.data}\n</file>`,
      });
    } else if (img.kind === "video") {
      const videoPath = resolveVideoPath(img);
      if (modelSupportsVideo) {
        // Video-capable models (Kimi/Gemini/MiniMax) watch video via the read
        // tool, which auto-compresses to each model's cap and delivers it in the
        // provider's required shape. Point at the real on-disk path (any size).
        parts.push({
          type: "text",
          text: videoPath
            ? `The user attached a video at ${videoPath}. You CAN watch it: call the read tool ` +
              `on this exact path now, then answer based on what you see. Do not say you ` +
              `cannot watch video — reading the file lets you analyze it.`
            : `[User attached a video but it could not be saved for analysis]`,
        });
      } else {
        // Models without video analysis: state the attachment plainly, with no
        // "analyze this video" framing that would confuse a model that can't.
        parts.push({
          type: "text",
          text: videoPath
            ? `[User attached a video file at ${videoPath}. You cannot watch video directly; ` +
              `if needed, use ffmpeg to extract frames or audio.]`
            : `[User attached a video file.]`,
        });
      }
    } else if (modelSupportsImages) {
      parts.push({ type: "image", mediaType: img.mediaType, data: img.data });
    } else {
      // GLM models: save image to temp file and route through the Z.AI vision
      // MCP server (connected only for the GLM provider — see core/mcp/defaults.ts).
      // Non-GLM providers must not see this hint: the server never connects for
      // them, so naming it would be a phantom tool. Their text is unchanged.
      const ext = img.mediaType.split("/")[1] ?? "png";
      // os.tmpdir(), never a hardcoded /tmp: Windows has no /tmp and the write
      // would throw, degrading every GLM image hint to the "could not be saved"
      // fallback on the Windows CI leg (and for Windows users).
      const tmpPath = path.join(os.tmpdir(), `ggcoder-img-${Date.now()}.${ext}`);
      try {
        writeFileSync(tmpPath, Buffer.from(img.data, "base64"));
        const hint =
          provider === "glm"
            ? `[User attached an image saved at: ${tmpPath} — analyze it with the ` +
              `mcp__zai_vision__analyze_image tool (if that tool is not available yet, ` +
              `call tool_search with "analyze image" to unlock it first, then call it with image_source=${tmpPath})]`
            : `[User attached an image saved at: ${tmpPath} — use the image_analysis tool to view and analyze it]`;
        parts.push({ type: "text", text: hint });
      } catch {
        parts.push({
          type: "text",
          text: `[User attached an image but it could not be saved for analysis]`,
        });
      }
    }
  }

  // If only text parts remain after stripping images, simplify to plain string
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}
