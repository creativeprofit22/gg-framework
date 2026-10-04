import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  createContext,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import { toast } from "./toast";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ArrowElbowDownLeftIcon,
  CheckIcon,
  CopyIcon,
  FilePlusIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STEROIDS_COLLAPSIBLE_TABLE_MARKER } from "@kenkaiiii/gg-core/slash-command-contract";
import { codeLanguage, codeNodeText } from "./markdown-prompt";
import { KenPromptActionContext } from "./ken-prompt-context";
import { PaneIdContext } from "./pane-context";
import {
  KEN_PROMPT_TITLE_MAX_LENGTH,
  normalizeKenPrompt,
  type KenPromptAction,
  type KenPromptActionResult,
  type KenPromptSavePreview,
} from "./ken-prompt-actions";
import {
  collapsedCode,
  diffLineKind,
  diffMetaEnd,
  isDiffLanguage,
  shouldCollapseCode,
  visibleBlockCount,
} from "./collapse";
import { marked } from "marked";
import { rehypeAnimateWords } from "./rehype-animate-words";
import { useAnimatedHeight } from "./animated-height";
import "highlight.js/styles/github-dark.css";

interface Props {
  children: string;
  /**
   * True while this text is actively streaming in: the trailing block wraps
   * its words in spans that fade in on mount. Off by default, and dropped
   * again once the stream settles, so finished prose carries no extra DOM.
   */
  animate?: boolean;
}

// Only link destinations get local-path exceptions; images retain the default filter.
function markdownUrlTransform(value: string, key: string): string {
  if (key === "href") {
    // Markdown percent-encodes Windows backslashes before this transform.
    if (/^[a-z]:(?:[/\\]|%5c)/i.test(value)) return value.replace(/%5c/gi, "/");
    // Known schemes retain their protocol policy, even with numeric payloads.
    const reservedScheme =
      /^(?:https?|mailto|ircs?|xmpp|javascript|data|vbscript|file|blob|about|ftps?|tel|sms|wss?):/i;
    if (!reservedScheme.test(value) && /^[^:/\\?#]+:\d+(?::\d+)?$/.test(value)) {
      return `./${value}`;
    }
    if (/^file:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        // Network file hosts are not local files.
        if (url.hostname && url.hostname !== "localhost") return "";
        return url.pathname.replace(/^\/([a-z]:\/)/i, "$1") + url.search + url.hash;
      } catch {
        return "";
      }
    }
  }
  return defaultUrlTransform(value);
}

function isExternalHref(href: string): boolean {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return Boolean(scheme && scheme !== "file" && scheme.length > 1);
}

/**
 * Anchor that opens outside the webview. Browser links go to the OS browser;
 * file-ish links from the agent (`src/App.tsx`, `/abs/file.ts`, `file://…`) open
 * against the originating pane's cwd.
 */
function ExternalLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const paneId = useContext(PaneIdContext);
  return (
    <a
      href={href}
      onClick={async (e) => {
        if (href?.startsWith("#")) return;
        e.preventDefault();
        // No usable address: a link still streaming in (its placeholder is
        // blanked by react-markdown's URL filter), an unsafe one the filter
        // removed, or `[x]()`. Following an empty href would reload the app.
        if (!href) return;
        try {
          if (isExternalHref(href)) {
            await openUrl(href);
          } else {
            const { openProjectPath } = await import("./agent");
            await openProjectPath(href, paneId, "url");
          }
        } catch (error) {
          toast(`Could not open link: ${String(error)}`, "error");
        }
      }}
    >
      {children}
    </a>
  );
}

const CollapsibleTableContext = createContext(false);
/** Rows a folded /steroids table keeps visible (the top-ranked candidates). */
const COLLAPSED_TABLE_ROWS = 3;
/** True while the enclosing collapsible table is folded to its first rows. */
const TableFoldedContext = createContext(false);

/** Count the body rows in a hast `<table>`, without rendering them. */
function tableBodyRowCount(node: ExtraProps["node"]): number {
  let rows = 0;
  for (const section of node?.children ?? []) {
    if (section.type !== "element" || section.tagName !== "tbody") continue;
    for (const row of section.children) {
      if (row.type === "element" && row.tagName === "tr") rows += 1;
    }
  }
  return rows;
}

/**
 * Tables live inside their own horizontal scroller so the table itself can stay
 * a real `display: table` at 100% width — it then fills and re-flows with the
 * pane as it resizes, and only scrolls when its columns can't wrap any narrower.
 *
 * The /steroids candidates table folds to its top rows; a toggle under it
 * reveals the rest or folds it back.
 */
function MarkdownTable({
  children,
  node,
}: {
  children?: React.ReactNode;
} & ExtraProps): React.ReactElement {
  const collapsible = useContext(CollapsibleTableContext);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const captureHeight = useAnimatedHeight(rootRef, expanded);
  const panelId = useId();
  const totalRows = tableBodyRowCount(node);
  const foldable = collapsible && totalRows > COLLAPSED_TABLE_ROWS;
  const folded = foldable && !expanded;
  const table = (
    <div className="md-table-scroll" id={panelId} tabIndex={0} role="region" aria-label="Table">
      <table>
        <TableFoldedContext.Provider value={folded}>{children}</TableFoldedContext.Provider>
      </table>
    </div>
  );
  if (!collapsible) return table;
  // A collapsible table keeps one wrapper shape before and after it grows past
  // the fold, so a streaming table isn't remounted (replaying its word fade-in
  // and resetting its scroll) when the toggle first appears.
  return (
    <div ref={rootRef} className={`md-table-collapsible${folded ? " folded" : ""}`}>
      {table}
      {foldable && (
        <button
          type="button"
          className="code-expand"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => {
            captureHeight();
            setExpanded(!expanded);
          }}
        >
          {folded ? `Show all ${totalRows} repos` : `Show top ${COLLAPSED_TABLE_ROWS} only`}
        </button>
      )}
    </div>
  );
}

/** Table body that drops rows past the fold while its table is folded. */
function MarkdownTableBody({ children }: { children?: React.ReactNode }): React.ReactElement {
  const folded = useContext(TableFoldedContext);
  if (!folded) return <tbody>{children}</tbody>;
  const rows = Children.toArray(children).filter(isValidElement);
  return <tbody>{rows.slice(0, COLLAPSED_TABLE_ROWS)}</tbody>;
}

/** Cells with at least this much text are sentences, not labels. */
const PROSE_CELL_CHARS = 24;

/**
 * A body cell. Sentence-length cells get a readable minimum width
 * (`.md-cell-prose`), so a wide table scrolls instead of squeezing them into a
 * word per line; short labels ("Low", "Done") keep their natural width. Only
 * `style` (GFM column alignment) is carried over from the parser.
 */
function TableCell({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  const prose = codeNodeText(children).length >= PROSE_CELL_CHARS;
  return (
    <td className={prose ? "md-cell-prose" : undefined} style={style}>
      {children}
    </td>
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
  const [copyStatus, setCopyStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const copyLockRef = useRef(false);
  const copyPrompt = async () => {
    if (copyLockRef.current) return;
    copyLockRef.current = true;
    setCopyStatus("pending");
    try {
      await navigator.clipboard.writeText(body.replace(/\n$/, ""));
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    } finally {
      copyLockRef.current = false;
    }
  };
  const copyLabel = copyStatus === "pending" ? "Copying prompt…" : "Copy prompt";
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
      if (!dispatcher || (!prompt && action.type !== "send-fresh") || actionLockRef.current)
        return null;
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
    const result = await runAction({ type: "send-fresh", prompt: body.replace(/\n$/, "") });
    if (result?.status === "sent") {
      setSaveDraft(null);
      setAnnouncement("Started in new session.");
    }
  }, [body, runAction]);

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
                <CheckIcon size={12} aria-hidden="true" />
              ) : (
                <ArrowElbowDownLeftIcon size={12} aria-hidden="true" />
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
              <PlusIcon size={14} aria-hidden="true" />
              New session
            </button>
            <div className="ken-prompt-local-actions">
              <button
                ref={saveButtonRef}
                type="button"
                className="ken-prompt-action"
                aria-expanded={saveDraft !== null}
                aria-controls={`${panelId}-save`}
                onClick={() => void prepareSave()}
                disabled={disabled}
              >
                <FilePlusIcon size={14} aria-hidden="true" />
                Save to Notes
              </button>
              <button
                type="button"
                className="ken-prompt-action ken-prompt-copy"
                aria-label={copyLabel}
                title={copyLabel}
                disabled={copyStatus === "pending"}
                onClick={() => void copyPrompt()}
              >
                {copyStatus === "success" ? (
                  <CheckIcon size={14} aria-hidden="true" />
                ) : (
                  <CopyIcon size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
          {copyStatus === "success" && (
            <p className="ken-prompt-success" role="status">
              Prompt copied.
            </p>
          )}
          {copyStatus === "error" && (
            <div className="ken-prompt-error" role="alert">
              Could not copy prompt. Try Copy again or select the prompt text manually.
            </div>
          )}

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
 * A folded `diff` preview with one span per coloured line, so added/removed
 * lines keep their tint while the hidden lines stay unmounted.
 */
function DiffPreview({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  return (
    <code className="hljs language-diff">
      {lines.map((line, index) => {
        const kind = diffLineKind(line);
        const newline = index < lines.length - 1 ? "\n" : "";
        // Preview lines are static and positional, so the index is a stable key.
        if (kind === "meta") {
          // Hunk headers colour only the `@@ … @@` match, like highlight.js.
          const end = diffMetaEnd(line) ?? line.length;
          return (
            <Fragment key={index}>
              <span className="hljs-meta">{line.slice(0, end)}</span>
              {line.slice(end) + newline}
            </Fragment>
          );
        }
        return kind ? (
          <Fragment key={index}>
            <span className={`hljs-${kind}`}>{line}</span>
            {newline}
          </Fragment>
        ) : (
          <Fragment key={index}>{line + newline}</Fragment>
        );
      })}
    </code>
  );
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
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const captureHeight = useAnimatedHeight(blockRef, expanded);

  // Raw text drives both the copy fallback and the fold decision. The rendered
  // `children` is the highlighted tree; while folded we deliberately do NOT
  // mount it, so a thousand-line dump costs seven lines of DOM instead of a
  // thousand highlighted spans. That withheld markup is the memory win.
  const text = codeNodeText(children);
  const collapsible = shouldCollapseCode(text);
  const folded = collapsible && !expanded;
  const { preview, hiddenLines } = collapsedCode(text);

  const copy = useCallback(() => {
    // Read the full source, not the folded preview, so copying a collapsed
    // block still yields the whole thing.
    const rendered = preRef.current?.innerText ?? "";
    const value = text || rendered;
    if (!value) return;
    void navigator.clipboard
      .writeText(value.replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);

  return (
    <div ref={blockRef} className={`code-block${folded ? " folded" : ""}`}>
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        ref={preRef}
        onDoubleClick={(e) => {
          if (selectWordAtPoint(e.clientX, e.clientY)) e.preventDefault();
        }}
      >
        {folded ? (
          isDiffLanguage(codeLanguage(children)) ? (
            <DiffPreview text={preview} />
          ) : (
            preview
          )
        ) : (
          children
        )}
      </pre>
      {collapsible && (
        <button
          type="button"
          className="code-expand"
          onClick={() => {
            captureHeight();
            setExpanded(!expanded);
          }}
        >
          {folded ? `Show full output (${hiddenLines} more lines)` : "Show less"}
        </button>
      )}
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
    let offset = 0;
    return tokens.flatMap((token) => {
      // marked normalizes CRLF/CR before lexing. Recover each token's original
      // source span so runnable prompt text never inherits that normalization.
      const start = offset;
      for (let index = 0; index < token.raw.length; index++, offset++) {
        if (markdown[offset] === "\r" && markdown[offset + 1] === "\n") offset++;
      }
      const raw = markdown.slice(start, offset);
      const end = promptClosingFenceEnd(raw);
      // marked rejects trailing tabs that the renderer accepts on closing fences.
      // Split there so later prompts cannot inherit this prompt's ready state.
      if (end !== null && raw.slice(end).trim()) {
        return [raw.slice(0, end), ...parseMarkdownIntoBlocks(raw.slice(end))];
      }
      return [raw];
    });
  } catch {
    return [markdown];
  }
}

/**
 * Whether a marked block's raw text is a COMPLETE ```prompt fence (closing ```
 * present), as opposed to one still being streamed. marked auto-closes an open
 * fence into a code token at EOF, so require a standalone closing line with at
 * least as many backticks as the opener. This reveals the prompt actions when
 * this prompt finishes, not when Ken's whole reply ends.
 */
function isPromptBlockComplete(raw: string): boolean {
  return promptClosingFenceEnd(raw) !== null;
}

function promptClosingFenceEnd(raw: string): number | null {
  return promptSourceFence(raw)?.end ?? null;
}

function promptSourceFence(raw: string): { body: string; end: number } | null {
  const opening = /^ {0,3}(`{3,})[ \t]*prompt\b[^\r\n]*(?:\r\n|\r|\n)/i.exec(raw);
  if (!opening) return null;
  const body = raw.slice(opening[0].length);
  for (const closing of body.matchAll(/(?:^|\r\n|\r|\n) {0,3}(`{3,})[ \t]*(?=\r|\n|$)/g)) {
    if (closing[1].length >= opening[1].length) {
      return {
        body: body.slice(0, closing.index),
        end: opening[0].length + closing.index + closing[0].length,
      };
    }
  }
  return null;
}

const ANIMATED_PLUGINS = [rehypeHighlight, rehypeAnimateWords];
/**
 * How long a block keeps its word spans after a newer block starts below it.
 * Covers the reveal catching up plus the word fade (`--dur-row`, 220ms), so the
 * last words of a finished paragraph finish fading instead of snapping solid.
 */
const WORD_FADE_HOLD_MS = 450;
const PLUGINS = [rehypeHighlight];
const COMPONENTS = {
  a: ExternalLink,
  pre: PreBlock,
  table: MarkdownTable,
  tbody: MarkdownTableBody,
  td: TableCell,
};

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    promptReady,
    animate,
    collapseTable,
  }: {
    content: string;
    promptReady: boolean;
    animate: boolean;
    collapseTable: boolean;
  }): React.ReactElement {
    const normalized = content.replace(/^\n+|\n+$/g, "");
    const sourceFence = promptSourceFence(content);
    if (sourceFence && promptReady) {
      return (
        <PromptReadyContext.Provider value={true}>
          <PromptBlock body={`${sourceFence.body}\n`} />
        </PromptReadyContext.Provider>
      );
    }
    return (
      <PromptReadyContext.Provider value={promptReady}>
        <CollapsibleTableContext.Provider value={collapseTable}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={animate ? ANIMATED_PLUGINS : PLUGINS}
            components={COMPONENTS}
            urlTransform={markdownUrlTransform}
          >
            {normalized}
          </ReactMarkdown>
        </CollapsibleTableContext.Provider>
      </PromptReadyContext.Provider>
    );
  },
  (prev, next) =>
    prev.content === next.content &&
    prev.promptReady === next.promptReady &&
    prev.animate === next.animate &&
    prev.collapseTable === next.collapseTable,
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
export const Markdown = memo(function Markdown({
  children,
  animate = false,
}: Props): React.ReactElement {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
  const [rowExpanded, setRowExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const captureHeight = useAnimatedHeight(rootRef, rowExpanded);
  // Oversized content mounts only its leading blocks. Fenced-code folding above
  // handles one huge block; this handles the other shape, hundreds of ordinary
  // blocks in a single row, which no per-block rule would catch.
  const visibleCount = useMemo(() => visibleBlockCount(blocks), [blocks]);
  const rowFolded = !rowExpanded && visibleCount < blocks.length;
  const visible = rowFolded ? blocks.slice(0, visibleCount) : blocks;
  const lastIndex = visible.length - 1;
  // Blocks from `spanFrom` on carry word spans while the row animates. A block
  // that stops being the last one keeps them for WORD_FADE_HOLD_MS, so its
  // final words finish fading; dropping them at once cut those fades short and
  // the words snapped solid at the end of every paragraph. Blocks already on
  // screen at mount (history) never get spans.
  const [spanFrom, setSpanFrom] = useState(() => Math.max(0, lastIndex));
  const holdTimers = useRef(new Set<number>());
  useEffect(() => {
    if (!animate || lastIndex <= spanFrom) return;
    const timer = window.setTimeout(() => {
      holdTimers.current.delete(timer);
      setSpanFrom((prev) => Math.max(prev, lastIndex));
    }, WORD_FADE_HOLD_MS);
    holdTimers.current.add(timer);
    // Not cleared on the next block: each finished block gets its full hold.
  }, [animate, lastIndex, spanFrom]);
  useEffect(() => {
    const timers = holdTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
  return (
    <div ref={rootRef} className="markdown">
      {visible.map((block, index) => (
        // A ```prompt block reveals its "Send to GG Coder" button as soon as ITS
        // own closing fence arrives (per-block), not when the whole reply ends —
        // so the button shows right after Ken finishes the prompt even if he
        // keeps talking after it.
        <MemoizedMarkdownBlock
          key={index}
          content={block}
          promptReady={isPromptBlockComplete(block)}
          // Only the trailing block is still growing; the ones just above it
          // keep their spans briefly so their last words finish fading. Older
          // blocks stay memoized and span-free.
          animate={animate && index >= spanFrom}
          collapseTable={
            index > 0 && visible[index - 1].trim() === STEROIDS_COLLAPSIBLE_TABLE_MARKER
          }
        />
      ))}
      {rowFolded && (
        <button
          type="button"
          className="code-expand"
          onClick={() => {
            captureHeight();
            setRowExpanded(true);
          }}
        >
          {`Show full output (${blocks.length - visibleCount} more blocks)`}
        </button>
      )}
    </div>
  );
});

/** Typed action boundary for every completed Ken prompt fence. */
export { KenPromptActionProvider } from "./ken-prompt-context";
