/** Images shared by live ACP tool results and restored tool messages.
 * Forward existing bytes only: never read tool-supplied paths or fetch URLs.
 * Bound encoded data below the remote client's frame ceiling.
 */
const MAX_IMAGE_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 16;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type ImageContent = {
  type: "content";
  content: { type: "image"; mimeType: string; data: string };
};

export function acpToolImages(content: unknown, details?: unknown): ImageContent[] {
  const output: ImageContent[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const add = (mimeType: unknown, data: unknown): void => {
    if (
      typeof mimeType !== "string" ||
      !MIME_TYPES.has(mimeType) ||
      typeof data !== "string" ||
      !data.length ||
      data.length % 4 !== 0 ||
      data.length > MAX_IMAGE_CONTENT_BYTES - bytes ||
      output.length >= MAX_IMAGES ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      seen.has(data)
    )
      return;
    seen.add(data);
    bytes += data.length;
    output.push({ type: "content", content: { type: "image", mimeType, data } });
  };

  // Persisted ToolResultContent uses mediaType, while ACP uses mimeType.
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "image") add(block.mediaType, block.data);
    }
  }
  // Live results are flattened text; their existing desktop previews remain
  // in details and must be forwarded separately.
  const previews = (details as { imagePreviews?: unknown } | null)?.imagePreviews;
  if (Array.isArray(previews)) {
    for (const preview of previews) add(preview?.mediaType, preview?.base64);
  }
  return output;
}
