import { describe, expect, it } from "vitest";
import { sha256 } from "../tauri-package/paths.js";
import {
  finalizeEmbeddedDigest,
  generatedFile,
  placeholderKeysIn,
  renderPlaceholders,
  renderTemplate,
} from "./render.js";

const SENTINEL = "0".repeat(64);

describe("generated-file rendering", () => {
  it("replaces each placeholder exactly once and inserts values literally", () => {
    const rendered = renderTemplate("a={{A}}\nb={{B}}\n", [
      ["{{B}}", "$1 $$"],
      ["{{A}}", "$& $`"],
    ]);
    expect(rendered).toBe("a=$& $`\nb=$1 $$\n");
  });

  it("does not expand placeholders that appear inside inserted values", () => {
    expect(renderTemplate("{{A}}|{{B}}", [
      ["{{A}}", "{{B}}"],
      ["{{B}}", "x"],
    ])).toBe("{{B}}|x");
  });

  it("rejects missing, repeated, empty and overlapping placeholders", () => {
    expect(() => renderTemplate("none", [["{{A}}", "x"]])).toThrow("exactly once");
    expect(() => renderTemplate("{{A}}{{A}}", [["{{A}}", "x"]])).toThrow("exactly once");
    expect(() => renderTemplate("x", [["", "x"]])).toThrow("non-empty");
    expect(() =>
      renderTemplate("{{AB}}", [
        ["{{AB}}", "x"],
        ["AB}", "y"],
      ]),
    ).toThrow("overlap");
  });

  it("renders identical bytes on repeated calls", () => {
    const render = () =>
      renderTemplate('{"name": "{{NAME}}", "port": {{PORT}}}\n', [
        ["{{NAME}}", "demo"],
        ["{{PORT}}", "1420"],
      ]);
    expect(render()).toBe(render());
    expect(generatedFile("a.json", render(), sha256("t"))).toEqual(
      generatedFile("a.json", render(), sha256("t")),
    );
  });

  it("finalises one embedded digest sentinel", () => {
    const final = finalizeEmbeddedDigest(`# content_sha256=${SENTINEL}\nbody\n`, SENTINEL);
    expect(final.bytes.toString("utf8")).toBe(`# content_sha256=${final.contentSha256}\nbody\n`);
    expect(() => finalizeEmbeddedDigest("no sentinel", SENTINEL)).toThrow("one digest sentinel");
    expect(() => finalizeEmbeddedDigest("x", "short")).toThrow("64 lowercase hex");
  });

  it("renders {{key}} placeholders literally in one pass", () => {
    expect(renderPlaceholders("a={{name}} b={{name}} c={{other}}", { name: "$& {{other}}" })).toBe(
      "a=$& {{other}} b=$& {{other}} c={{other}}",
    );
    expect(renderPlaceholders("{{Upper}} {{ name }} {{x}}", { x: "1" })).toBe(
      "{{Upper}} {{ name }} 1",
    );
    expect(renderPlaceholders("{{constructor}}", {})).toBe("{{constructor}}");
    expect(() => renderPlaceholders("x", { "Bad-Key": "x" })).toThrow("Invalid placeholder key");
    expect(placeholderKeysIn("{{b}}{{a}}{{b}}{{Bad}}")).toEqual(["b", "a"]);
  });

  it("records the byte digest for side-record files of any format", () => {
    const file = generatedFile("config.yaml", "key: value\n", sha256("template"));
    expect(file.content_sha256).toBe(sha256(Buffer.from("key: value\n")));
    expect(file.template_sha256).toBe(sha256("template"));
  });
});
