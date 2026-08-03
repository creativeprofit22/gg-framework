import {
  memo,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  createContext,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, CornerDownLeft, FilePlus2, Plus } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { codeLanguage, codeNodeText } from "./markdown-prompt";
import {
  KEN_PROMPT_TITLE_MAX_LENGTH,
  normalizeKenPrompt,
  type KenPromptAction,
  type KenPromptActionDispatcher,
  type KenPromptActionResult,
  type KenPromptSavePreview,
} from "./ken-prompt-actions";
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
          void import("./agent").then(({ openProjectPath }) => openProjectPath(href));
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
 * True once the surrounding Ken bubble has FINISHED streaming. While Ken is
 * still typing the prompt, this is false and the "Send to GG Coder" button is
 * withheld so the user can't fire a half-written prompt by accident. Defaults to
 * true so ordinary (non-streaming) renders — resumed history, GG Coder text —
 * always show the button. Provided by Markdown; consumed by PromptBlock.
 */
const PromptReadyContext = createContext(true);

const KenPromptActionContext = createContext<KenPromptActionDispatcher | null>(null);

type PendingPromptAction = KenPromptAction["type"];
type SaveDestinationKind = "new-draft" | "existing-phase";

interface SaveDraftState {
  preview: KenPromptSavePreview;
  destination: SaveDestinationKind;
  phaseId: string;
  title: string;
}

function pendingPromptLabel(action: PendingPromptAction): string {
  if (action === "send-fresh") return "Starting a new session…";
  if (action === "prepare-save") return "Loading Project Notes…";
  if (action === "commit-save") return "Saving to Project Notes…";
  return "Continuing here…";
}

/** A complete Ken prompt with one primary action and two guarded destinations. */
function PromptBlock({ body }: { body: string }): React.ReactElement {
  const ready = useContext(PromptReadyContext);
  const dispatcher = useContext(KenPromptActionContext);
  const panelId = useId();
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const newSessionButtonRef = useRef<HTMLButtonElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const phaseSelectRef = useRef<HTMLSelectElement>(null);
  const actionLockRef = useRef(false);
  const [continued, setContinued] = useState(false);
  const [pending, setPending] = useState<PendingPromptAction | null>(null);
  const [saveDraft, setSaveDraft] = useState<SaveDraftState | null>(null);
  const [failedAction, setFailedAction] = useState<KenPromptAction | null>(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const prompt = useMemo(() => normalizeKenPrompt(body), [body]);

  const focusAction = useCallback(
    (action: PendingPromptAction) => {
      window.setTimeout(() => {
        if (action === "send-current") continueButtonRef.current?.focus();
        else if (action === "send-fresh") newSessionButtonRef.current?.focus();
        else if (action === "prepare-save") saveButtonRef.current?.focus();
        else if (saveDraft?.destination === "new-draft") titleInputRef.current?.focus();
        else phaseSelectRef.current?.focus();
      }, 0);
    },
    [saveDraft?.destination],
  );

  const closeSaveEditor = useCallback((returnFocus: boolean) => {
    setSaveDraft(null);
    setFailedAction(null);
    setError("");
    if (returnFocus) queueMicrotask(() => saveButtonRef.current?.focus());
  }, []);

  const runAction = useCallback(
    async (action: KenPromptAction): Promise<KenPromptActionResult | null> => {
      if (!dispatcher || !prompt || actionLockRef.current) return null;
      actionLockRef.current = true;
      setPending(action.type);
      setFailedAction(null);
      setError("");
      setAnnouncement("");
      try {
        const result = await dispatcher.dispatch(action);
        if (result.status === "failed") {
          if (result.preview) {
            setSaveDraft((current) =>
              current
                ? {
                    ...current,
                    preview: result.preview!,
                    phaseId: result.preview!.destinations.some(
                      (destination) => destination.phaseId === current.phaseId,
                    )
                      ? current.phaseId
                      : (result.preview!.destinations[0]?.phaseId ?? ""),
                  }
                : current,
            );
          }
          setFailedAction(action);
          setError(result.message);
          focusAction(action.type);
        }
        return result;
      } catch {
        setFailedAction(action);
        setError("The prompt action failed. Your prompt is still available. Try again.");
        focusAction(action.type);
        return null;
      } finally {
        actionLockRef.current = false;
        setPending(null);
      }
    },
    [dispatcher, focusAction, prompt],
  );

  const sendCurrent = useCallback(async () => {
    const result = await runAction({ type: "send-current", prompt });
    if (result?.status === "sent") {
      setContinued(true);
      setAnnouncement("Continued here.");
    }
  }, [prompt, runAction]);

  const sendFresh = useCallback(async () => {
    const result = await runAction({ type: "send-fresh", prompt });
    if (result?.status === "sent") {
      setSaveDraft(null);
      setAnnouncement("Started in new session.");
    }
  }, [prompt, runAction]);

  const prepareSave = useCallback(async () => {
    const result = await runAction({ type: "prepare-save", prompt });
    if (result?.status !== "preview") return;
    const recommendation = result.preview.recommendedDestination;
    setSaveDraft({
      preview: result.preview,
      destination: recommendation?.kind ?? "new-draft",
      phaseId:
        recommendation?.kind === "existing-phase"
          ? recommendation.phaseId
          : (result.preview.destinations[0]?.phaseId ?? ""),
      title: result.preview.suggestedTitle,
    });
    queueMicrotask(() => titleInputRef.current?.focus());
  }, [prompt, runAction]);

  const commitSave = useCallback(async () => {
    if (!saveDraft) return;
    const title = saveDraft.title.trim();
    if (saveDraft.destination === "new-draft" && !title) {
      setFailedAction(null);
      setError("Enter a title for the new draft.");
      queueMicrotask(() => titleInputRef.current?.focus());
      return;
    }
    const selected = saveDraft.preview.destinations.find(
      (destination) => destination.phaseId === saveDraft.phaseId,
    );
    if (saveDraft.destination === "existing-phase" && !selected) {
      setFailedAction(null);
      setError("Choose an existing phase.");
      queueMicrotask(() => phaseSelectRef.current?.focus());
      return;
    }
    const result = await runAction({
      type: "commit-save",
      prompt,
      target:
        saveDraft.destination === "new-draft"
          ? { kind: "new-draft", title }
          : {
              kind: "existing-phase",
              phaseId: selected!.phaseId,
              title: selected!.title,
              expectedSourcePrompt: selected!.sourcePrompt,
            },
    });
    if (result?.status === "saved") {
      setSaveDraft(null);
      setAnnouncement(`Saved to ${result.title}.`);
    }
  }, [prompt, runAction, saveDraft]);

  const retryFailedAction = useCallback(() => {
    if (!failedAction) {
      if (saveDraft) void commitSave();
      return;
    }
    if (failedAction.type === "send-current") void sendCurrent();
    else if (failedAction.type === "send-fresh") void sendFresh();
    else if (failedAction.type === "prepare-save") void prepareSave();
    else void commitSave();
  }, [commitSave, failedAction, prepareSave, saveDraft, sendCurrent, sendFresh]);

  const disabled = pending !== null;
  const currentSessionBlockedReason = dispatcher?.blockedReason?.("send-current") ?? null;
  const freshSessionBlockedReason = dispatcher?.blockedReason?.("send-fresh") ?? null;
  const selectedPhase = saveDraft?.preview.destinations.find(
    (destination) => destination.phaseId === saveDraft.phaseId,
  );
  const replacement =
    saveDraft?.destination === "existing-phase" && Boolean(selectedPhase?.sourcePrompt);

  return (
    <div className="ken-prompt-block" aria-busy={pending !== null}>
      <pre className="ken-prompt-body">{body.replace(/\n$/, "")}</pre>
      {ready && dispatcher && (
        <>
          <div className="ken-prompt-actions">
            <button
              ref={continueButtonRef}
              type="button"
              className={`ken-prompt-send${continued ? " sent" : ""}`}
              onClick={() => void sendCurrent()}
              disabled={disabled || continued || currentSessionBlockedReason !== null}
              title={currentSessionBlockedReason ?? undefined}
            >
              {continued ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <CornerDownLeft size={12} aria-hidden="true" />
              )}
              {continued ? "Continued" : "Continue here"}
            </button>
            <button
              ref={newSessionButtonRef}
              type="button"
              className="ken-prompt-action"
              onClick={() => void sendFresh()}
              disabled={disabled || freshSessionBlockedReason !== null}
              title={freshSessionBlockedReason ?? undefined}
            >
              <Plus size={14} aria-hidden="true" />
              New session
            </button>
            <button
              ref={saveButtonRef}
              type="button"
              className="ken-prompt-action"
              aria-expanded={saveDraft !== null}
              aria-controls={`${panelId}-save`}
              onClick={() => void prepareSave()}
              disabled={disabled}
            >
              <FilePlus2 size={14} aria-hidden="true" />
              Save to Notes
            </button>
          </div>

          {saveDraft && (
            <div
              id={`${panelId}-save`}
              className="ken-prompt-action-panel"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeSaveEditor(true);
              }}
            >
              <form
                className="ken-prompt-save-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void commitSave();
                }}
              >
                <fieldset disabled={disabled}>
                  <legend>Save to Project Notes</legend>
                  <label className="ken-prompt-radio">
                    <input
                      type="radio"
                      name={`${panelId}-destination`}
                      checked={saveDraft.destination === "new-draft"}
                      onChange={() =>
                        setSaveDraft((current) =>
                          current ? { ...current, destination: "new-draft" } : current,
                        )
                      }
                    />
                    New draft
                  </label>
                  <div className="ken-prompt-save-field">
                    <label htmlFor={`${panelId}-title`}>Draft title</label>
                    <input
                      ref={titleInputRef}
                      id={`${panelId}-title`}
                      value={saveDraft.title}
                      maxLength={KEN_PROMPT_TITLE_MAX_LENGTH}
                      required={saveDraft.destination === "new-draft"}
                      disabled={saveDraft.destination !== "new-draft" || disabled}
                      onChange={(event) =>
                        setSaveDraft((current) =>
                          current ? { ...current, title: event.target.value } : current,
                        )
                      }
                    />
                  </div>
                  <label className="ken-prompt-radio">
                    <input
                      type="radio"
                      name={`${panelId}-destination`}
                      checked={saveDraft.destination === "existing-phase"}
                      disabled={saveDraft.preview.destinations.length === 0}
                      onChange={() =>
                        setSaveDraft((current) =>
                          current ? { ...current, destination: "existing-phase" } : current,
                        )
                      }
                    />
                    Existing phase
                  </label>
                  <div className="ken-prompt-save-field">
                    <label htmlFor={`${panelId}-phase`}>Phase destination</label>
                    <select
                      ref={phaseSelectRef}
                      id={`${panelId}-phase`}
                      value={saveDraft.phaseId}
                      disabled={
                        saveDraft.destination !== "existing-phase" ||
                        saveDraft.preview.destinations.length === 0 ||
                        disabled
                      }
                      onChange={(event) =>
                        setSaveDraft((current) =>
                          current ? { ...current, phaseId: event.target.value } : current,
                        )
                      }
                    >
                      {saveDraft.preview.destinations.map((destination) => (
                        <option key={destination.phaseId} value={destination.phaseId}>
                          {destination.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </fieldset>

                <p className="ken-prompt-destination-preview">
                  {saveDraft.destination === "new-draft"
                    ? `New draft: ${saveDraft.title.trim() || "Untitled"}`
                    : `Phase: ${selectedPhase?.title ?? "Choose a phase"}`}
                </p>
                {replacement && (
                  <p className="ken-prompt-replacement">
                    This replaces the prompt currently saved in {selectedPhase?.title}.
                  </p>
                )}
                <div className="ken-prompt-preview">
                  <strong>Prompt preview</strong>
                  <pre>{saveDraft.preview.prompt}</pre>
                </div>
                <div className="ken-prompt-save-actions">
                  <button type="submit" disabled={disabled}>
                    {replacement ? "Replace saved prompt" : "Save prompt"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveDraft(null);
                      setFailedAction(null);
                      setError("");
                      queueMicrotask(() => saveButtonRef.current?.focus());
                    }}
                    disabled={disabled}
                  >
                    Back
                  </button>
                </div>
              </form>
            </div>
          )}

          {pending && (
            <p className="ken-prompt-pending" role="status">
              {pendingPromptLabel(pending)}
            </p>
          )}
          {announcement && (
            <p className="ken-prompt-success" role="status">
              {announcement}
            </p>
          )}
          {error && (
            <div className="ken-prompt-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={retryFailedAction} disabled={disabled}>
                Try again
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Dispatch for ReactMarkdown's `pre` override. Hook-free so the branch is safe:
 * a ```prompt fence (Ken's runnable-prompt contract) renders as a PromptBlock
 * with a "Send to GG Coder" button; everything else is a normal CodeBlock.
 */
function PreBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  if (codeLanguage(children) === "prompt") {
    return <PromptBlock body={codeNodeText(children)} />;
  }
  return <CodeBlock>{children}</CodeBlock>;
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

/**
 * Whether a marked block's raw text is a COMPLETE ```prompt fence (closing ```
 * present), as opposed to one still being streamed. marked auto-closes an open
 * fence into a code token at EOF, so a closed block's raw ends with ``` while a
 * still-streaming one ends with the body. This is what reveals Ken's "Send to GG
 * Coder" button the instant the prompt finishes, not when his whole reply ends.
 */
function isPromptBlockComplete(raw: string): boolean {
  const t = raw.trim();
  if (!/^`{3,}[ \t]*prompt\b/i.test(t)) return false;
  const firstNewline = t.indexOf("\n");
  if (firstNewline === -1) return false; // only the opening line so far
  const body = t.slice(firstNewline + 1).trimEnd();
  return /`{3,}\s*$/.test(body);
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    promptReady,
  }: {
    content: string;
    promptReady: boolean;
  }): React.ReactElement {
    const normalized = content.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
    return (
      <PromptReadyContext.Provider value={promptReady}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{ a: ExternalLink, pre: PreBlock }}
        >
          {normalized}
        </ReactMarkdown>
      </PromptReadyContext.Provider>
    );
  },
  (prev, next) => prev.content === next.content && prev.promptReady === next.promptReady,
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
        // A ```prompt block reveals its "Send to GG Coder" button as soon as ITS
        // own closing fence arrives (per-block), not when the whole reply ends —
        // so the button shows right after Ken finishes the prompt even if he
        // keeps talking after it.
        <MemoizedMarkdownBlock
          key={index}
          content={block}
          promptReady={isPromptBlockComplete(block)}
        />
      ))}
    </div>
  );
});

/** Typed action boundary for every completed Ken prompt fence. */
export const KenPromptActionProvider = KenPromptActionContext.Provider;
