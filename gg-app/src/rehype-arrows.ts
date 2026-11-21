/**
 * Rehype plugin: typed arrows become real ones in prose. "->" reads as "→" and
 * "<-" as "←"; "<->" becomes "↔" and "=>" stays as typed (it's code-ish in
 * prose, and turning it into ⇒ surprises more than it helps).
 *
 * Code, preformatted text and links are left exactly as written: a shell
 * redirect, a C pointer or a URL must not change. Longer runs ("-->", "<--")
 * are left alone too, since they're usually ASCII art or comments.
 */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

/** Text inside these is literal, not prose. */
const LITERAL = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "a",
  "svg",
  "math",
  "style",
  "script",
  "textarea",
]);

/** Replace standalone arrows; dashes or angle brackets on either side opt out. */
export function prettyArrows(text: string): string {
  return text
    .replace(/(?<![-<>=])<->(?![-<>])/g, "\u2194")
    .replace(/(?<![-<>=])->(?![->])/g, "\u2192")
    .replace(/(?<![<-])<-(?![-<>])/g, "\u2190");
}

function walk(node: HastNode): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === "text" && child.value) child.value = prettyArrows(child.value);
    else if (child.type === "element" && !LITERAL.has(child.tagName ?? "")) walk(child);
  }
}

export function rehypeArrows() {
  return (tree: HastNode): void => walk(tree);
}
