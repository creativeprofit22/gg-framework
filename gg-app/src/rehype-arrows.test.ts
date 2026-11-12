import { describe, expect, it } from "vitest";
import { prettyArrows, rehypeArrows } from "./rehype-arrows";

describe("prettyArrows", () => {
  it.each([
    ["Settings -> Appearance", "Settings \u2192 Appearance"],
    ["go back <- here", "go back \u2190 here"],
    ["two-way <-> sync", "two-way \u2194 sync"],
    ["a->b", "a\u2192b"],
  ])("%s", (input, output) => {
    expect(prettyArrows(input)).toBe(output);
  });

  it.each(["x --> y", "x <-- y", "a => b", "<!-- comment -->", "x >-> y"])(
    "leaves %s as typed",
    (input) => {
      expect(prettyArrows(input)).toBe(input);
    },
  );
});

describe("rehypeArrows", () => {
  it("changes prose but never code or links", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [
            { type: "text", value: "Open Settings -> Appearance, run " },
            { type: "element", tagName: "code", children: [{ type: "text", value: "a -> b" }] },
            { type: "element", tagName: "a", children: [{ type: "text", value: "x->y" }] },
          ],
        },
        { type: "element", tagName: "pre", children: [{ type: "text", value: "cat a -> b" }] },
      ],
    };
    rehypeArrows()(tree);
    const p = tree.children[0]!;
    expect(p.children?.[0]?.value).toBe("Open Settings \u2192 Appearance, run ");
    expect(p.children?.[1]?.children?.[0]?.value).toBe("a -> b");
    expect(p.children?.[2]?.children?.[0]?.value).toBe("x->y");
    expect(tree.children[1]?.children?.[0]?.value).toBe("cat a -> b");
  });
});
