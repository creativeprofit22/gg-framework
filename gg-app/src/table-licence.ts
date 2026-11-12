/** How freely a repo's code can be reused, from its licence cell. */
export type LicenceTier = "permissive" | "weak-copyleft" | "strong-copyleft" | "unclear";

// Checked in this order, so "NOASSERTION (AGPL …)" stays unclear and a dual
// "GPL-2.0 OR MIT" reads as the stricter licence.
const TIERS: readonly (readonly [RegExp, LicenceTier])[] = [
  [
    /\b(?:NONE|NOASSERTION|UNLICENSED|PROPRIETARY|NON-?COMMERCIAL|NC|BUSL|SSPL|ELASTIC|COMMONS CLAUSE|CUSTOM|OTHER|UNKNOWN)\b/,
    "unclear",
  ],
  [/\b(?:AGPL|GPL|EUPL|OSL)\b/, "strong-copyleft"],
  [/\b(?:LGPL|MPL|EPL|CDDL|MS-RL|CECILL)\b/, "weak-copyleft"],
  [
    /\b(?:MIT|MIT-0|APACHE|BSD|0BSD|ISC|UNLICENSE|ZLIB|CC0|WTFPL|BSL-1\.0|BOOST|POSTGRESQL|PYTHON|ARTISTIC|CC-BY|X11|NCSA|UPL)\b/,
    "permissive",
  ],
];

/** True for a "Licence"/"License" column header. */
export function isLicenceHeader(label: string): boolean {
  return /\blicen[cs]es?\b/i.test(label);
}

/** The tier a licence cell names (SPDX ids or plain words), or null if none is recognised. */
export function licenceTier(text: string): LicenceTier | null {
  const value = text.toUpperCase();
  return TIERS.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}
