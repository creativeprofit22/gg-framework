import { normalizedContentSha256, sha256 } from "../tauri-package/paths.js";
import type { GeneratedFile } from "./owner.js";

export type TemplateReplacement = readonly [placeholder: string, value: string];

/**
 * Logic-free template rendering: every placeholder must appear exactly once and
 * values are inserted literally, so `$&` or `$1` in a value are never patterns.
 */
export function renderTemplate(
  template: string,
  replacements: ReadonlyArray<TemplateReplacement>,
): string {
  const located = replacements.map(([placeholder, value]) => {
    if (!placeholder) throw new Error("Template placeholder must be non-empty");
    const parts = template.split(placeholder);
    if (parts.length !== 2) {
      throw new Error(
        `Template placeholder must appear exactly once: ${JSON.stringify(placeholder)}`,
      );
    }
    return { start: parts[0]!.length, end: parts[0]!.length + placeholder.length, value };
  });
  located.sort((left, right) => left.start - right.start);
  let output = "";
  let cursor = 0;
  for (const item of located) {
    if (item.start < cursor) throw new Error("Template placeholders must not overlap");
    output += template.slice(cursor, item.start) + item.value;
    cursor = item.end;
  }
  return output + template.slice(cursor);
}

/** Placeholder keys used by `{{key}}` family templates. */
export const PLACEHOLDER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const PLACEHOLDER_TOKEN = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;

/**
 * Logic-free `{{key}}` rendering for family templates. One left-to-right pass:
 * only keys present in `values` are replaced, inserted values are never
 * re-expanded, and unknown `{{...}}` text stays literal. The fixed Node helper
 * in `programmatic/family-generator.ts` mirrors this exactly.
 */
export function renderPlaceholders(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  for (const key of Object.keys(values)) {
    if (!PLACEHOLDER_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid placeholder key: ${JSON.stringify(key)}`);
    }
  }
  return text.replace(PLACEHOLDER_TOKEN, (token: string, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? token) : token,
  );
}

/** Keys of `{{key}}` tokens that appear in the text, in first-use order. */
export function placeholderKeysIn(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    const key = match[1];
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Replace the single digest sentinel with the digest of the content normalised
 * around its `content_sha256` field (the embedded-marker ownership scheme).
 */
export function finalizeEmbeddedDigest(
  contentWithSentinel: string,
  sentinel: string,
): { bytes: Buffer; contentSha256: string } {
  if (!/^[a-f0-9]{64}$/.test(sentinel)) {
    throw new Error("Digest sentinel must be 64 lowercase hex characters");
  }
  const occurrences = contentWithSentinel.split(sentinel).length - 1;
  if (occurrences !== 1) throw new Error("Generated content must contain one digest sentinel");
  const contentSha256 = normalizedContentSha256(contentWithSentinel);
  return {
    bytes: Buffer.from(renderTemplate(contentWithSentinel, [[sentinel, contentSha256]]), "utf8"),
    contentSha256,
  };
}

/** Build a generated file whose ownership lives in a side record (any format). */
export function generatedFile(
  repositoryPath: string,
  bytes: Buffer | string,
  templateSha256: string,
): GeneratedFile {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return {
    path: repositoryPath,
    bytes: buffer,
    template_sha256: templateSha256,
    content_sha256: sha256(buffer),
  };
}
