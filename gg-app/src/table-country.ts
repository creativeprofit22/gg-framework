const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
const LEADING_TAG = /^(\s*)\(([A-Z]{2})\)/;

/** A two-letter country tag written right after a repo link, as in `[o/n](url) (CN)`. */
export interface RepoCountryTag {
  code: string;
  /** English country name, for the hover title. */
  name: string;
  /** Text before the tag (usually one space). */
  leading: string;
  /** Text after the tag. */
  rest: string;
}

/** English name of an ISO 3166 region code, or null when it isn't one. */
export function regionName(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  let name: string | undefined;
  try {
    name = REGION_NAMES.of(code);
  } catch {
    return null;
  }
  return name && name !== code && name !== "Unknown Region" ? name : null;
}

/** The country tag a text node starts with, or null. */
export function leadingRepoCountry(text: string): RepoCountryTag | null {
  const match = LEADING_TAG.exec(text);
  const code = match?.[2];
  if (!match || !code) return null;
  const name = regionName(code);
  if (!name) return null;
  return { code, name, leading: match[1] ?? "", rest: text.slice(match[0].length) };
}
