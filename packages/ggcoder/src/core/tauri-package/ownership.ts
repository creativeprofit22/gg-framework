import {
  commitGeneratedSet,
  inspectGeneratedSet,
  type CommitOptions,
  type EmbeddedMarker,
  type GeneratedSetSpec,
} from "../generated-files/owner.js";
import { finalizeEmbeddedDigest } from "../generated-files/render.js";
import {
  CONTENT_DIGEST_SENTINEL,
  GENERATED_PATHS,
  TAURI_PACKAGE_MARKER,
  normalizedContentSha256,
} from "./paths.js";
import { TEMPLATE_VERSION, type GeneratedFile, type SupportSetInspection } from "./types.js";

export type { CommitOptions } from "../generated-files/owner.js";

const MARKER_PATTERN = new RegExp(
  `${TAURI_PACKAGE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+template_version=(\\d+)\\s+template_sha256=([a-f0-9]{64})\\s+content_sha256=([a-f0-9]{64})`,
);

export function generatedMarker(templateSha256: string, contentSha256: string): string {
  return `${TAURI_PACKAGE_MARKER} template_version=${TEMPLATE_VERSION} template_sha256=${templateSha256} content_sha256=${contentSha256}`;
}

export function finalizeGeneratedContent(contentWithSentinel: string): {
  bytes: Buffer;
  contentSha256: string;
} {
  return finalizeEmbeddedDigest(contentWithSentinel, CONTENT_DIGEST_SENTINEL);
}

export function parseGeneratedMarker(content: string): EmbeddedMarker | null {
  const match = MARKER_PATTERN.exec(content);
  if (!match) return null;
  return {
    templateVersion: Number(match[1]),
    templateSha256: match[2]!,
    contentSha256: match[3]!,
  };
}

/** Tauri keeps in-file markers (no side record) so its outputs stay byte-identical. */
export const TAURI_SET: GeneratedSetSpec = {
  ownerId: "tauri-package",
  paths: GENERATED_PATHS,
  completeSet: true,
  // The generated calibrate script rewrites the config (and its marker) in place.
  byteCompareExempt: [GENERATED_PATHS[4]],
  lockName: "gg-tauri-package",
  tempPrefix: ".gg-tauri-",
  label: "Tauri support",
  ownership: {
    kind: "embedded-marker",
    parse: parseGeneratedMarker,
    templateVersion: TEMPLATE_VERSION,
    digest: normalizedContentSha256,
  },
  messages: {
    busy: "Another Tauri packaging action is active for this repository",
    incomplete: "Renderer must provide the exact six-file Tauri support set",
  },
};

export async function inspectSupportSet(
  repositoryRoot: string,
  expected?: readonly GeneratedFile[],
): Promise<SupportSetInspection> {
  return inspectGeneratedSet(repositoryRoot, TAURI_SET, expected);
}

export async function commitSupportSet(
  repositoryRoot: string,
  rendered: readonly GeneratedFile[],
  options: CommitOptions = {},
): Promise<{ changed: boolean; paths: string[] }> {
  return commitGeneratedSet(repositoryRoot, TAURI_SET, rendered, options);
}
