/**
 * Rehype plugin: wrap each word in a `<span class="md-word">` so newly-arrived
 * words can fade in individually.
 *
 * This is the half of smooth streaming that pacing alone can't do. Even a
 * perfectly paced reveal still POPS each word into place; a short blur-to-sharp
 * fade on mount hides the exact moment a word appeared. React reconciles these
 * spans by index, so a word still growing character-by-character keeps its
 * element and does not re-trigger its animation.
 *
 * Applied only to the block that is actively streaming (see `Markdown.tsx`), so
 * finished prose carries no extra DOM.
 */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

/** Text inside these never splits: it is code, math, or markup, not prose. */
const OPAQUE = new Set(["code", "pre", "svg", "math", "style", "script", "textarea"]);

function splitWords(node: HastNode): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      // Whitespace stays a bare text node so lines still break normally
      // between the (inline-block) word spans.
      for (const part of child.value.match(/\s+|\S+/g) ?? []) {
        next.push(
          /^\s/.test(part)
            ? { type: "text", value: part }
            : {
                type: "element",
                tagName: "span",
                properties: { className: ["md-word"] },
                children: [{ type: "text", value: part }],
              },
        );
      }
      continue;
    }
    if (child.type === "element" && !OPAQUE.has(child.tagName ?? "")) splitWords(child);
    next.push(child);
  }
  node.children = next;
}

export function rehypeAnimateWords() {
  return (tree: HastNode): void => splitWords(tree);
}
