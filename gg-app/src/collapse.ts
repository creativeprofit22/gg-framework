/**
 * Size thresholds that keep one transcript row from ballooning the webview.
 *
 * Virtualization bounds how MANY rows are mounted; these bound how BIG a single
 * mounted row can get. Both are needed: a session of only a few rows still hit
 * `1.5 GB` when one of those rows carried a 43 KB tool dump, because every
 * mounted line of it costs DOM, layout, style, and highlight markup.
 */

/**
 * Fenced blocks longer than this collapse to a preview. Seven lines is the
 * threshold Chatbox settled on for the same desktop-chat problem: long enough
 * to show a whole short snippet uncollapsed, short enough that command dumps
 * and file listings fold away.
 */
export const CODE_COLLAPSE_LINE_THRESHOLD = 7;

/** Lines kept visible in a collapsed block — the same count as the threshold. */
export const CODE_COLLAPSE_PREVIEW_LINES = CODE_COLLAPSE_LINE_THRESHOLD;

/**
 * Markdown content above this size renders only its leading blocks until the
 * reader asks for the rest. 8 KB is roughly two screens of prose, so ordinary
 * replies are never touched and only genuine dumps fold.
 */
export const ROW_COLLAPSE_CHARS = 8 * 1024;

/** Text of a fenced block, minus the trailing newline the fence leaves behind. */
export function codeLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** Whether a fenced block is long enough to fold. */
export function shouldCollapseCode(text: string): boolean {
  return codeLines(text).length > CODE_COLLAPSE_LINE_THRESHOLD;
}

/**
 * The preview shown while a block is folded, plus how many lines stay hidden.
 * Callers render `preview` as plain text instead of mounting the block's full
 * highlighted tree, which is where the memory is actually saved.
 */
export function collapsedCode(text: string): { preview: string; hiddenLines: number } {
  const lines = codeLines(text);
  if (lines.length <= CODE_COLLAPSE_LINE_THRESHOLD) {
    return { preview: lines.join("\n"), hiddenLines: 0 };
  }
  return {
    preview: lines.slice(0, CODE_COLLAPSE_PREVIEW_LINES).join("\n"),
    hiddenLines: lines.length - CODE_COLLAPSE_PREVIEW_LINES,
  };
}

/**
 * How many leading markdown blocks to mount for oversized content.
 *
 * Always at least one block, so a single enormous block still renders (its own
 * fenced-code collapse handles the size) rather than leaving an empty row.
 * Blocks are admitted whole: cutting mid-block would corrupt the markdown.
 */
export function visibleBlockCount(blocks: readonly string[], budget = ROW_COLLAPSE_CHARS): number {
  let used = 0;
  for (let index = 0; index < blocks.length; index++) {
    used += blocks[index].length;
    if (used > budget) return Math.max(1, index);
  }
  return blocks.length;
}

/** Whether content is large enough that `visibleBlockCount` will hold some back. */
export function shouldCollapseRow(blocks: readonly string[], budget = ROW_COLLAPSE_CHARS): boolean {
  return visibleBlockCount(blocks, budget) < blocks.length;
}
