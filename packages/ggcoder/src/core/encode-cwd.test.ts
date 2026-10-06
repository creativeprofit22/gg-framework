import { describe, expect, it } from "vitest";
import { encodeCwd, stripExtendedLengthPrefix } from "./encode-cwd.js";

describe("encodeCwd — Unix paths (unchanged behavior)", () => {
  it("encodes a typical Unix project path", () => {
    expect(encodeCwd("/Users/kenkai/Documents/gg-coder")).toBe("Users_kenkai_Documents_gg-coder");
  });

  it("drops only the leading slash, keeping interior underscores from the path", () => {
    expect(encodeCwd("/home/user/project")).toBe("home_user_project");
  });

  it("encodes a Windows path with a drive letter (plain form)", () => {
    expect(encodeCwd("C:\\Users\\brams")).toBe("C_Users_brams");
  });
});

describe("encodeCwd — Windows extended-length prefix (the crash bug)", () => {
  it("strips the \\\\?\\ prefix so ? never reaches the folder name", () => {
    const encoded = encodeCwd("\\\\?\\C:\\Users\\brams");
    // The whole point: no illegal characters survive.
    expect(encoded).not.toMatch(/[<>:"|?*]/);
    expect(encoded).toBe("C_Users_brams");
  });

  it("produces the SAME folder for canonicalized and plain Windows paths", () => {
    const plain = encodeCwd("C:\\Users\\brams\\project");
    const canonical = encodeCwd("\\\\?\\C:\\Users\\brams\\project");
    expect(canonical).toBe(plain);
  });

  it("normalizes the UNC extended-length variant to match plain UNC", () => {
    const plain = encodeCwd("\\\\server\\share\\project");
    const canonical = encodeCwd("\\\\?\\UNC\\server\\share\\project");
    expect(canonical).toBe(plain);
  });
});

describe("encodeCwd — Windows-reserved characters are all stripped", () => {
  // On Windows these characters are illegal in file/folder names:
  //   < > : " | ? *
  // A path won't normally contain most of these, but the encoder must be a
  // hard guarantee — `mkdir` will throw ENOENT/EINVAL if any survive.
  const reserved = ["<", ">", ":", '"', "|", "?", "*"];

  for (const ch of reserved) {
    it(`strips "${ch}"`, () => {
      const encoded = encodeCwd(`C:\\Users\\proj${ch}name`);
      expect(encoded).not.toContain(ch);
    });
  }
});

describe("encodeCwd — produces a valid folder name (no mkdir failure)", () => {
  it("never emits a name with a Windows-illegal character for realistic inputs", () => {
    const inputs = [
      "\\\\?\\C:\\Users\\brams",
      "\\\\?\\C:\\Users\\brams\\gg-projects\\my-app",
      "\\\\?\\UNC\\fileserver\\shared\\repo",
      "/Users/kenkai/Documents/gg-coder",
      "D:\\dev\\workspace",
    ];
    for (const input of inputs) {
      const encoded = encodeCwd(input);
      expect(encoded).toMatch(/^[^<>:"|?*\\/\s]+$/);
      expect(encoded.length).toBeGreaterThan(0);
    }
  });
});

describe("stripExtendedLengthPrefix", () => {
  // Shared by encodeCwd (write side) and project discovery (read side): both
  // must agree, or a project recorded as `\\?\C:\proj` by a shipped build
  // lists separately from the same project's plain `C:\proj`.
  it("normalizes a drive-letter extended-length path", () => {
    expect(stripExtendedLengthPrefix(String.raw`\\?\C:\Users\dev\proj`)).toBe(
      String.raw`C:\Users\dev\proj`,
    );
  });

  it("normalizes the UNC form back to a plain UNC path", () => {
    expect(stripExtendedLengthPrefix(String.raw`\\?\UNC\server\share\proj`)).toBe(
      String.raw`\\server\share\proj`,
    );
  });

  it("leaves plain Windows, UNC and POSIX paths untouched", () => {
    expect(stripExtendedLengthPrefix(String.raw`C:\Users\dev`)).toBe(String.raw`C:\Users\dev`);
    expect(stripExtendedLengthPrefix(String.raw`\\server\share`)).toBe(String.raw`\\server\share`);
    expect(stripExtendedLengthPrefix("/Users/dev")).toBe("/Users/dev");
  });

  it("agrees with encodeCwd: both forms map to one store directory", () => {
    expect(encodeCwd(String.raw`\\?\C:\Users\dev\proj`)).toBe(
      encodeCwd(String.raw`C:\Users\dev\proj`),
    );
  });
});
