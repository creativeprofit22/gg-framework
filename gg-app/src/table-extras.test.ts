import { describe, expect, it } from "vitest";
import { isPlaceholderCell } from "./markdown-table-data";
import { leadingRepoCountry, regionName } from "./table-country";
import { isLicenceHeader, licenceTier } from "./table-licence";

describe("licence tiers", () => {
  it("groups SPDX ids and plain words by how freely the code can be reused", () => {
    expect(licenceTier("MIT")).toBe("permissive");
    expect(licenceTier("Apache-2.0")).toBe("permissive");
    expect(licenceTier("BSD-3-Clause")).toBe("permissive");
    expect(licenceTier("Unlicense")).toBe("permissive");
    expect(licenceTier("LGPL-2.1")).toBe("weak-copyleft");
    expect(licenceTier("MPL-2.0")).toBe("weak-copyleft");
    expect(licenceTier("GPL-3.0")).toBe("strong-copyleft");
    expect(licenceTier("AGPL-3.0 ⚠ ideas only")).toBe("strong-copyleft");
    expect(licenceTier("UNLICENSED")).toBe("unclear");
    expect(licenceTier("none")).toBe("unclear");
    expect(licenceTier("NOASSERTION (AGPL + extra permission)")).toBe("unclear");
    expect(licenceTier("Non-commercial (NOASSERTION)")).toBe("unclear");
    expect(licenceTier("CC-BY-NC-4.0")).toBe("unclear");
    expect(licenceTier("GPL-2.0 OR MIT")).toBe("strong-copyleft");
    expect(licenceTier("Something odd")).toBeNull();
  });

  it("recognises licence headers in either spelling", () => {
    expect(isLicenceHeader("Licence")).toBe(true);
    expect(isLicenceHeader("License")).toBe(true);
    expect(isLicenceHeader("Licenses")).toBe(true);
    expect(isLicenceHeader("Licensed by")).toBe(false);
  });
});

describe("country tags", () => {
  it("reads a leading two-letter region code and keeps the rest", () => {
    expect(leadingRepoCountry(" (CN) desktop app")).toEqual({
      code: "CN",
      name: "China",
      leading: " ",
      rest: " desktop app",
    });
    expect(leadingRepoCountry("(JP)")?.name).toBe("Japan");
    expect(leadingRepoCountry(" (UI)")).toBeNull();
    expect(leadingRepoCountry(" (cn)")).toBeNull();
    expect(leadingRepoCountry(" see (CN)")).toBeNull();
    expect(regionName("KR")).toBe("South Korea");
    expect(regionName("ZZ")).toBeNull();
  });
});

describe("placeholder cells", () => {
  it("treats dashes, n/a and question marks as missing values", () => {
    for (const text of ["—", "–", "-", "n/a", "N/A", "?", " unknown "]) {
      expect(isPlaceholderCell(text)).toBe(true);
    }
    for (const text of ["", "0", "MIT", "-3"]) expect(isPlaceholderCell(text)).toBe(false);
  });
});
