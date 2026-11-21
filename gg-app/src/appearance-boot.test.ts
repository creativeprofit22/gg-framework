// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import bootSource from "../public/appearance-boot.js?raw";
import indexHtml from "../index.html?raw";
import { APPEARANCE_MAX_BYTES, APPEARANCE_STORAGE_KEY, parseAppearance } from "./appearance";
import { NATIVE_APPEARANCE_BACKGROUNDS } from "./appearance-native";

// A saved Light record whose raw JSON is exactly `length` characters long.
function lightRecordOfLength(length: number): string {
  const base = JSON.stringify({ theme: "light", pad: "" });
  const raw = JSON.stringify({ theme: "light", pad: "x".repeat(length - base.length) });
  expect(raw).toHaveLength(length);
  return raw;
}

function runBoot(): void {
  // The shipped file is a plain classic script; execute it as the page would.
  new Function(bootSource)();
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-appearance-theme");
  document.documentElement.style.colorScheme = "";
});

describe("pre-paint appearance boot script", () => {
  it("reads the same storage record the app owns", () => {
    expect(bootSource).toContain(JSON.stringify(APPEARANCE_STORAGE_KEY));
  });

  it("rejects records over the same size limit the app parser uses", () => {
    expect(bootSource).toContain(`raw.length > ${APPEARANCE_MAX_BYTES}`);
  });

  it("applies Light for a record exactly at the size limit, like the app", () => {
    const raw = lightRecordOfLength(APPEARANCE_MAX_BYTES);
    expect(parseAppearance(raw).theme).toBe("light");
    localStorage.setItem(APPEARANCE_STORAGE_KEY, raw);
    runBoot();
    expect(document.documentElement.getAttribute("data-appearance-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("leaves the Dark default one character over the size limit, like the app", () => {
    const raw = lightRecordOfLength(APPEARANCE_MAX_BYTES + 1);
    expect(parseAppearance(raw).theme).toBe("dark");
    localStorage.setItem(APPEARANCE_STORAGE_KEY, raw);
    runBoot();
    expect(document.documentElement.hasAttribute("data-appearance-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("");
  });

  it("loads as a blocking head script before the app bundle", () => {
    const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));
    expect(head).toContain('<script src="/appearance-boot.js"></script>');
    expect(head).toContain(`background: ${NATIVE_APPEARANCE_BACKGROUNDS.dark};`);
    expect(head).toContain(`background: ${NATIVE_APPEARANCE_BACKGROUNDS.light};`);
  });

  it.each(["light", "dark"] as const)("applies a saved %s theme before first paint", (theme) => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ theme, size: "16" }));
    runBoot();
    expect(document.documentElement.getAttribute("data-appearance-theme")).toBe(theme);
    expect(document.documentElement.style.colorScheme).toBe(theme);
  });

  it.each([
    ["missing", null],
    ["malformed", "{not json"],
    ["unknown theme", JSON.stringify({ theme: "purple" })],
    ["oversized", JSON.stringify({ theme: "light", pad: "x".repeat(4096) })],
  ])("leaves the Dark default for a %s record", (_label, raw) => {
    if (raw !== null) localStorage.setItem(APPEARANCE_STORAGE_KEY, raw);
    runBoot();
    expect(document.documentElement.hasAttribute("data-appearance-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("");
  });
});
