import { describe, it, expect } from "vitest";
import { rehypeAnimateWords } from "./rehype-animate-words";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  children?: Node[];
  properties?: Record<string, unknown>;
}

const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, children: Node[]): Node => ({ type: "element", tagName, children });
const run = (tree: Node): Node => {
  (rehypeAnimateWords() as (t: Node) => void)(tree);
  return tree;
};

describe("rehypeAnimateWords", () => {
  it("wraps words in spans and leaves whitespace as bare text", () => {
    const tree = run(el("p", [text("hello brave world")]));
    expect(tree.children?.map((c) => c.tagName ?? c.value)).toEqual([
      "span",
      " ",
      "span",
      " ",
      "span",
    ]);
    expect(tree.children?.[0].properties).toEqual({ className: ["md-word"] });
    expect(tree.children?.[0].children?.[0].value).toBe("hello");
  });

  it("leaves code untouched", () => {
    // Splitting inside <code> would shred the syntax highlighting spans and
    // break copy-paste of the block.
    const tree = run(el("pre", [el("code", [text("const a = 1")])]));
    const code = tree.children?.[0];
    expect(code?.children).toEqual([text("const a = 1")]);
  });

  it("descends into inline markup", () => {
    const tree = run(el("p", [el("strong", [text("two words")])]));
    expect(tree.children?.[0].children?.map((c) => c.tagName ?? c.value)).toEqual([
      "span",
      " ",
      "span",
    ]);
  });
});
