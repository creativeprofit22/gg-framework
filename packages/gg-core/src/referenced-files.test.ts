import { describe, expect, it } from "vitest";
import { appendReferencedFiles, parseReferencedFiles } from "./referenced-files.js";
describe("shared file-reference wire format", () => {
  it.each([
    "",
    "inspect café\n日本語",
    "Referenced files:\n- earlier.ts\n\nPlease inspect this example.",
  ])("round trips existing chip encoding for %j", (text) => {
    const files = ["src/a.ts", "folder with spaces/b.ts"];
    expect(parseReferencedFiles(appendReferencedFiles(text, files))).toEqual({ text, files });
    expect(appendReferencedFiles(text, [])).toBe(text);
  });
  it("preserves ordinary heading text and reads only the last contiguous chip block", () => {
    const plain = "Discuss\n\nReferenced files:\nnot a chip";
    expect(parseReferencedFiles(plain)).toEqual({ text: plain, files: [] });
    const text = "Earlier\n\nReferenced files:\n- first.ts";
    expect(parseReferencedFiles(`${text}\n\nReferenced files:\n- last.ts\nnot a chip\n- ignored.ts`))
      .toEqual({ text, files: ["last.ts"] });
  });
});
