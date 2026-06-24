import { memo, useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openProjectPath } from "./agent";
import { marked } from "marked";
import "highlight.js/styles/github-dark.css";

interface Props {
  children: string;
}

function isExternalHref(href: string): boolean {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return Boolean(scheme && scheme !== "file" && scheme.length > 1);
}

/**
 * Anchor that opens outside the webview. Browser links go to the OS browser;
 * file-ish links from the agent (`src/App.tsx`, `/abs/file.ts`, `file://…`) open
 * against the current project window's cwd.
 */
function ExternalLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!href || href.startsWith("#")) return;
        e.preventDefault();
        if (isExternalHref(href)) {
          void openUrl(href);
        } else {
          void openProjectPath(href);
        }
      }}
    >
      {children}
    </a>
  );
}

/**
 * Select the word under a point, bypassing the host webview's selection
 * granularity. macOS WKWebView (what Tauri renders in) double-clicks a
 * preformatted block by *paragraph*, selecting the entire code block instead
 * of one word. We override that: resolve the caret at the click, expand to the
 * surrounding word, and set the selection ourselves. Returns false if we can't
 * resolve a caret (then the native behavior stands).
 */
function selectWordAtPoint(x: number, y: number): boolean {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.textContent ?? "";
  if (!text) return false;
  // A "word" for code is a run of identifier characters; if the caret sits on a
  // non-word, non-space character, select the run of such symbols instead.
  const isWord = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const isSpace = (c: string): boolean => /\s/.test(c);
  let start = Math.min(offset, text.length);
  const cls = (c: string): 0 | 1 | 2 => (isSpace(c) ? 0 : isWord(c) ? 1 : 2);
  // Anchor on the character to the right of the caret, else the one to the left.
  const here = start < text.length ? text[start] : (text[start - 1] ?? "");
  const kind = cls(here);
  if (kind === 0) return false; // whitespace — let the default (collapse) stand
  if (start >= text.length) start = text.length - 1;
  let end = start;
  while (start > 0 && cls(text[start - 1]) === kind) start--;
  while (end < text.length && cls(text[end]) === kind) end++;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/**
 * A fenced code block wrapped with a hover-revealed copy button. The raw text
 * is read from the rendered `<pre>` (so it includes the exact code, minus the
 * syntax-highlight markup). Double-click is handled manually (see
 * `selectWordAtPoint`) so it grabs one word, not the whole block.
 */
function CodeBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    void navigator.clipboard
      .writeText(text.replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="code-block">
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        ref={preRef}
        onDoubleClick={(e) => {
          if (selectWordAtPoint(e.clientX, e.clientY)) e.preventDefault();
        }}
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * Split markdown into top-level blocks (headings, paragraphs, code blocks,
 * lists, etc.) using marked's lexer. Each block becomes a separately memoized
 * component so that during streaming, only the last (active) block re-parses
 * — earlier completed blocks hit React.memo and skip re-rendering entirely.
 *
 * This is the technique used by Vercel Streamdown, Cline, and the Vercel AI
 * SDK cookbook. It reduces per-token cost from O(message_length) to O(block_length).
 */
function parseMarkdownIntoBlocks(markdown: string): string[] {
  try {
    const tokens = marked.lexer(markdown);
    return tokens.map((token) => token.raw);
  } catch {
    return [markdown];
  }
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({ content }: { content: string }): React.ReactElement {
    const normalized = content.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ a: ExternalLink, pre: CodeBlock }}
      >
        {normalized}
      </ReactMarkdown>
    );
  },
  (prev, next) => prev.content === next.content,
);

/**
 * Renders assistant text as GitHub-flavored markdown with syntax-highlighted
 * fenced code blocks. Mirrors the TUI's Markdown.tsx role in the web build.
 *
 * Splits the text into top-level blocks via marked.lexer() and memoizes each
 * block individually. During streaming, when text_delta grows the last
 * paragraph, only that paragraph re-parses — all earlier blocks (finished
 * code blocks, completed paragraphs) hit memo() and bail out.
 */
export const Markdown = memo(function Markdown({ children }: Props): React.ReactElement {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock key={index} content={block} />
      ))}
    </div>
  );
});
