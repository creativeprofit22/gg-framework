import { describe, expect, it } from "vitest";
import { parseArgs, parseViewport, SCREENS } from "./dev-nav.mjs";

describe("dev-nav arguments", () => {
  it("expands all to every screen once, in declaration order", () => {
    expect(parseArgs(["all", "home"]).screens).toEqual(Object.keys(SCREENS));
  });

  it("defaults to one desktop and one phone viewport", () => {
    expect(parseArgs(["home"]).viewports).toEqual([
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]);
  });

  it("parses a viewport list", () => {
    expect(parseArgs(["chat", "--viewports", "1600x900,320x640"]).viewports).toEqual([
      { width: 1600, height: 900 },
      { width: 320, height: 640 },
    ]);
  });

  it.each([
    [[], /at least one screen/],
    [["nope"], /Unknown screen "nope"/],
    [["home", "--viewports"], /needs a value/],
    [["home", "--url", "https://example.com"], /loopback/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it.each(["1280", "1280x", "wide", "1x1"])("rejects malformed viewport %s", (value) => {
    expect(() => parseViewport(value)).toThrow(/1280x800/);
  });
});
