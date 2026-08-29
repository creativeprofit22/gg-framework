import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./Badge";
import { theme } from "./theme";
import type { AskOption, AskQuestion, AskUserPrompt } from "./ask-user";

/**
 * The in-thread question band (design-lab: ask-band-resolved.html).
 *
 * Sits inside the reply, full-bleed and tinted, so it scrolls with history and
 * owns no app chrome. Every option is a real button — mouse is the primary
 * path; the number badges printed on each option are an accelerator, and the
 * free-text field opens on click OR on typing a character. Answering collapses
 * the band in place to a single line.
 */

/** Past this many characters a label stops working as a chip and becomes a row. */
const CHIP_LABEL_MAX = 24;

const Check = (): React.ReactElement => (
  <svg
    className="ask-check"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const valueOf = (option: AskOption): string => option.value ?? option.label;

/** Free text is offered everywhere except when the model opts out. */
const allowsText = (q: AskQuestion): boolean => q.kind === "text" || q.allowOther !== false;

/**
 * Chips or rows is decided from the content, never by the model: long labels
 * (or labels carrying a hint) can't survive a 480px window as pills.
 */
function useRows(q: AskQuestion): boolean {
  return useMemo(
    () =>
      (q.options ?? []).some(
        (option) => option.hint !== undefined || option.label.length > CHIP_LABEL_MAX,
      ),
    [q.options],
  );
}

type Answers = Record<string, string | string[]>;

/**
 * An answered question, collapsed. Reuses the transcript's shimmer label (the
 * same treatment as the "ideal?" hook) so a resolved ask reads as one of the
 * app's own quiet status lines rather than a green form-validation tick.
 */
function AnsweredLine({ text }: { text: string }): React.ReactElement {
  return (
    <div className="ask-answered" aria-live="polite">
      <span className="user-msg ask-answered-bubble">
        <span className="shimmer-text">{text}</span>
      </span>
    </div>
  );
}

/** One question's controls: chips or rows, plus the route to the composer. */
function Question({
  question,
  index,
  numbered,
  answer,
  onAnswer,
  onTypeInstead,
}: {
  question: AskQuestion;
  /** 1-based accelerator offset across the whole band (0 = not accelerated). */
  index: number;
  numbered: boolean;
  answer: string | string[] | undefined;
  onAnswer: (value: string | string[]) => void;
  onTypeInstead: () => void;
}): React.ReactElement {
  const rows = useRows(question);
  const options = question.options ?? [];
  const multi = question.kind === "multi";
  const [picked, setPicked] = useState<string[]>([]);

  // A text-only question has nothing to click, so it sends the user straight to
  // the composer rather than rendering an empty band. The ref keeps that to one
  // hand-off per question: `onTypeInstead` is a fresh closure every render, and
  // re-running this would yank focus back mid-typing.
  const routed = useRef<string | null>(null);
  useEffect(() => {
    if (question.kind !== "text" || routed.current === question.id) return;
    routed.current = question.id;
    onTypeInstead();
  }, [question.kind, question.id, onTypeInstead]);

  if (answer !== undefined) {
    return (
      <div className="ask-subq is-done">
        {numbered && <span className="ask-subq-num">{index}</span>}
        <AnsweredLine text={Array.isArray(answer) ? answer.join(", ") : answer} />
      </div>
    );
  }

  // Every option is the app's standard pill: ghost by default, primary only
  // when it is actually selected. The recommendation is marked with the shared
  // .badge, so color stays a data signal instead of decoration.
  const optionButton = (option: AskOption, position: number): React.ReactElement => {
    const value = valueOf(option);
    const index = position <= 9 ? <span className="ask-num">{position}</span> : null;
    // Green: the recommendation is the one affirmative signal in the list, and
    // a neutral pill was indistinguishable from the row's own raised fill.
    const tag = option.recommended ? <Badge color={theme.success}>Recommended</Badge> : null;
    const on = multi && picked.includes(value);
    return (
      <button
        key={value}
        type="button"
        className={`btn btn-sm ${on ? "btn-primary" : "btn-ghost"}`}
        {...(multi ? { "aria-pressed": on } : { "data-ask-option": true })}
        onClick={() =>
          multi
            ? setPicked((current) =>
                current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
              )
            : onAnswer(value)
        }
      >
        {multi ? on && <Check /> : index}
        {option.hint ? (
          <span className="ask-row-main">
            <span>{option.label}</span>
            <span className="ask-row-hint">{option.hint}</span>
          </span>
        ) : (
          <span>{option.label}</span>
        )}
        {tag}
      </button>
    );
  };

  const escape = allowsText(question) ? (
    <button type="button" className="ask-escape" onClick={onTypeInstead} data-ask-type>
      Something else
    </button>
  ) : null;

  return (
    <div className="ask-subq" data-ask-question={question.id}>
      <p className="ask-subq-q">
        {numbered && <span className="ask-subq-num">{index}</span>}
        {question.question}
      </p>
      {question.detail && <p className="ask-detail">{question.detail}</p>}
      {options.length > 0 && (
        <div
          className={`ask-options${rows ? " rows" : ""}`}
          role="group"
          aria-label={question.question}
        >
          {options.map((option, i) => optionButton(option, i + 1))}
          {!rows && !multi && escape}
        </div>
      )}
      {multi && (
        <div className="ask-foot">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={picked.length === 0}
            onClick={() => onAnswer(picked)}
          >
            {picked.length === 0 ? "Choose at least one" : `Send ${picked.length} selected`}
          </button>
          {escape}
        </div>
      )}
    </div>
  );
}

export function AskBand({
  prompt,
  answers = {},
  sent,
  cancelled,
  onAnswer,
  onTypeInstead,
}: {
  prompt: AskUserPrompt;
  /**
   * Answers so far, owned by App. The band is deliberately controlled: a typed
   * answer arrives from the composer, outside this component, so local state
   * here would fork from the real one.
   */
  answers?: Answers;
  /** The answers have been sent to the blocked tool call — collapse the band. */
  sent?: boolean;
  /** The run ended without an answer — the question is dead, say so quietly. */
  cancelled?: boolean;
  /** Report answered questions. App merges, then settles once none are left. */
  onAnswer: (delta: Answers) => void;
  /** The user wants to write their own answer: focus the composer, seeded. */
  onTypeInstead: (questionId: string, seed?: string) => void;
}): React.ReactElement {
  const bandRef = useRef<HTMLDivElement | null>(null);
  const questions = prompt.questions;
  const done = sent === true;

  const acceptAllRecommended = useCallback(() => {
    const delta: Answers = {};
    for (const q of questions) {
      if (answers[q.id] !== undefined) continue;
      const rec = q.options?.find((o) => o.recommended);
      if (rec) delta[q.id] = valueOf(rec);
    }
    onAnswer(delta);
  }, [answers, questions, onAnswer]);

  // Number accelerators + type-to-open. Both are deliberately inert while the
  // user is typing anywhere else (the composer is a focused textarea), so the
  // band never steals a keystroke meant for the prompt box.
  useEffect(() => {
    if (done || cancelled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The target is the document itself when nothing is focused, so this
      // cannot assume an Element.
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      const band = bandRef.current;
      if (!band) return;
      // The first still-open question owns the keyboard.
      const open = band.querySelector<HTMLElement>("[data-ask-question]");
      if (!open) return;
      if (/^[1-9]$/.test(e.key)) {
        const options = open.querySelectorAll<HTMLButtonElement>("[data-ask-option]");
        const button = options[Number(e.key) - 1];
        if (button) {
          e.preventDefault();
          button.click();
        }
        return;
      }
      // Any printed character means they want to write their own answer: send
      // them to the composer they already type in, carrying the keystroke,
      // rather than opening a second input inside the transcript.
      if (e.key.length === 1 && e.key !== " ") {
        const id = open.dataset.askQuestion;
        if (id) {
          e.preventDefault();
          onTypeInstead(id, e.key);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done, cancelled, onTypeInstead]);

  if (cancelled && !done) {
    return (
      <div className="ask-band is-closed">
        <span className="ask-closed">
          This question was cancelled, so it no longer needs an answer.
        </span>
      </div>
    );
  }

  if (done) {
    const text = questions
      .map((q) => {
        const value = answers[q.id];
        return Array.isArray(value) ? value.join(", ") : value;
      })
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="ask-band is-done">
        <AnsweredLine text={text} />
      </div>
    );
  }

  const multiQuestion = questions.length > 1;
  const remaining = questions.filter((q) => answers[q.id] === undefined).length;
  const hasRecommendations = questions.every((q) => q.options?.some((o) => o.recommended));

  return (
    <div className="ask-band" ref={bandRef} role="group" aria-label="GG Coder needs your answer">
      {questions.map((q, i) => (
        <Question
          key={q.id}
          question={q}
          index={i + 1}
          numbered={multiQuestion}
          answer={answers[q.id]}
          onAnswer={(value) => onAnswer({ [q.id]: value })}
          onTypeInstead={() => onTypeInstead(q.id)}
        />
      ))}
      {multiQuestion && (
        <div className="ask-foot">
          {hasRecommendations && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={acceptAllRecommended}>
              Use every recommended answer
            </button>
          )}
          <span className="ask-hint">
            {remaining === 0
              ? "All answered"
              : `${questions.length - remaining} of ${questions.length} answered`}
          </span>
        </div>
      )}
    </div>
  );
}
