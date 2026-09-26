import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeUri } from "./client.js";

describe("normalizeUri", () => {
  // Diagnostics are cached by URI string, so our key and the server's must be
  // identical. There is no single canonical spelling of a file URI, and on
  // Windows we and tsserver disagreed in two independent ways at once, so every
  // lookup missed. The diagnostics arrived and were dropped on the floor —
  // reported as a clean file, because LSP degrades silently by design.
  it("collapses the exact URI pair observed on Windows CI", () => {
    // Captured verbatim from a wire trace on `windows-latest`: `~` is an RFC
    // 3986 unreserved character that pathToFileURL escapes and tsserver leaves
    // literal; the drive colon is the reverse.
    const ours = "file:///c:/Users/RUNNER%7E1/AppData/Local/Temp/p/src/main.ts";
    const theirs = "file:///c%3A/Users/RUNNER~1/AppData/Local/Temp/p/src/main.ts";

    expect(ours).not.toBe(theirs); // the bug: raw strings differ
    expect(normalizeUri(ours)).toBe(normalizeUri(theirs)); // the fix
  });

  it("lowercases the Windows drive letter, encoded or not", () => {
    expect(normalizeUri("file:///C:/repo/src/a.ts")).toBe("file:///c:/repo/src/a.ts");
    expect(normalizeUri("file:///c:/repo/src/a.ts")).toBe("file:///c:/repo/src/a.ts");
    expect(normalizeUri("file:///C%3A/repo/a.ts")).toBe("file:///c:/repo/a.ts");
  });

  it("decodes escapes so spaces and 8.3 short names match either spelling", () => {
    // `C:\Program Files\…` and its `PROGRA~1` short form are ordinary Windows
    // paths, not edge cases.
    expect(normalizeUri("file:///c:/Program%20Files/app/a.ts")).toBe(
      normalizeUri("file:///c:/Program Files/app/a.ts"),
    );
    expect(normalizeUri("file:///c:/PROGRA%7E1/a.ts")).toBe(
      normalizeUri("file:///c:/PROGRA~1/a.ts"),
    );
  });

  it("round-trips a real pathToFileURL against a literal-tilde server reply", () => {
    // Guards the actual production pairing rather than hand-written constants.
    const filePath =
      process.platform === "win32"
        ? "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p\\src\\main.ts"
        : "/tmp/RUNNER~1/p/src/main.ts";
    const ours = pathToFileURL(filePath).href;
    const serverStyle = ours.replace(/%7E/gi, "~").replace(/^(file:\/\/\/)([A-Za-z]):/, "$1$2%3A");

    expect(normalizeUri(ours)).toBe(normalizeUri(serverStyle));
    expect(path.isAbsolute(filePath)).toBe(true);
  });

  it("leaves POSIX and non-file URIs untouched", () => {
    expect(normalizeUri("file:///Users/dev/a.ts")).toBe("file:///Users/dev/a.ts");
    expect(normalizeUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });

  it("preserves case outside the drive letter", () => {
    // POSIX servers are genuinely case-sensitive and share this code path, so
    // case must not be folded beyond the Windows drive letter.
    expect(normalizeUri("file:///c:/Repo/SRC/MyFile.ts")).toBe("file:///c:/Repo/SRC/MyFile.ts");
  });

  it("falls back to the raw URI on a malformed escape instead of throwing", () => {
    // This runs inside a notification handler; throwing there would take out
    // the diagnostics pipeline entirely.
    expect(normalizeUri("file:///c:/bad%ZZ/a.ts")).toBe("file:///c:/bad%ZZ/a.ts");
  });
});
