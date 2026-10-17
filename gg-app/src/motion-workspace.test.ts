import { describe, expect, it } from "vitest";
import { motionWorkspacePath } from "./motion-workspace";

describe("motionWorkspacePath", () => {
  it.each([
    ["/Users/me/Projects", "/Users/me/Projects/GG Motion"],
    ["/Users/me/Projects/", "/Users/me/Projects/GG Motion"],
    ["C:\\Users\\me\\Projects", "C:\\Users\\me\\Projects\\GG Motion"],
    ["C:\\Users\\me\\Projects\\", "C:\\Users\\me\\Projects\\GG Motion"],
    ["C:/Users/me/Projects", "C:/Users/me/Projects/GG Motion"],
  ])("places the Motion folder inside %s", (root, expected) => {
    expect(motionWorkspacePath(root)).toBe(expected);
  });
});
