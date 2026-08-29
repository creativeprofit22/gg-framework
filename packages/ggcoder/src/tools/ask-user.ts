import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  ASK_USER_TIMEOUT_MS,
  formatAskResult,
  type AskQuestion,
  type AskUserRequest,
  type AskUserResult,
} from "../core/ask-user.js";

/** Ask the host to put the questions in front of the user and wait. */
export type AskUserHandler = (request: AskUserRequest) => Promise<AskUserResult>;

/** Beyond this the band stops being a question and becomes a form. */
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 6;

const Option = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      "A COMPLETE decision you can act on immediately, in plain words — what the user GETS, " +
        "not the technical thing you do. Clicking sends this option and NOTHING else, so it " +
        "must never ask the user to specify, describe, choose or clarify anything further: " +
        "there is no text box behind a button. Bad: 'Fix something specific', 'Tell me more', " +
        "'Something else', 'Other'. Good: 'Fix the failing upload test', 'Roll back the last " +
        "deploy'. Under ~24 chars renders as a chip. Never a bare file path or jargon term.",
    ),
  value: z.string().optional().describe("What you receive if picked. Defaults to the label."),
  hint: z
    .string()
    .optional()
    .describe(
      "One short line under the label saying what this choice costs or trades off, in " +
        "everyday language. Use it whenever the difference is not obvious from the label.",
    ),
  recommended: z
    .boolean()
    .optional()
    .describe(
      "Marks your recommendation. Tagged in the UI, never preselected. Max one per question.",
    ),
});

const Question = z.object({
  id: z.string().min(1).describe("Stable key your answer comes back under, e.g. `store`."),
  question: z
    .string()
    .min(1)
    .describe(
      "The question in one plain line a non-technical person can answer without opening the " +
        "code. Ask about the outcome they want, not the implementation. Define any term you " +
        "cannot avoid. It must be answerable by a single click — never an open-ended prompt " +
        "like 'What would you like me to do?', which a button cannot answer.",
    ),
  kind: z
    .enum(["confirm", "choice", "multi", "text"])
    .describe(
      "confirm = yes/no · choice = pick one of `options` · multi = pick any of `options` · text = free text only.",
    ),
  detail: z
    .string()
    .optional()
    .describe(
      "One optional line of context under the question — the background they need to choose, " +
        "in the same plain language.",
    ),
  options: z.array(Option).max(MAX_OPTIONS).optional().describe("Required for choice/multi."),
  allowOther: z
    .boolean()
    .optional()
    .describe("Offer the free-text escape alongside the options. Default true."),
});

const AskUserParams = z.object({
  questions: z
    .array(Question)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("One question, or the few that block you. Never pad the list."),
});

/** Yes/No is implied by `confirm`, so the model never has to spell it out. */
const CONFIRM_OPTIONS = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

/**
 * Options that hand the decision straight back to the user.
 *
 * A click carries no payload beyond the option itself, so "Fix something
 * specific" reaches the agent as literally that — an instruction it cannot
 * act on. Catching it here turns a dead-end question into a tool error the
 * model can immediately correct, instead of a button that wastes a turn.
 */
const DEFERRING = [
  /\bsomething specific\b/i,
  /\bsomething else\b/i,
  /^(other|tell me more|you (choose|decide)|let me (specify|decide|explain))\b/i,
  /\b(specify|describe|clarify|choose|pick|select|name)\b.*\b(it|one|which|what|something|a file|the file)\b/i,
];

function defersBack(option: { label: string }): boolean {
  return DEFERRING.some((re) => re.test(option.label.trim()));
}

function normalize(question: z.infer<typeof Question>): AskQuestion {
  const options =
    question.kind === "confirm" && !question.options?.length ? CONFIRM_OPTIONS : question.options;
  return {
    id: question.id,
    question: question.question,
    kind: question.kind,
    ...(question.detail ? { detail: question.detail } : {}),
    ...(options ? { options } : {}),
    ...(question.allowOther !== undefined ? { allowOther: question.allowOther } : {}),
  };
}

/**
 * Ask the user a question and block the turn until they answer.
 *
 * Registered only by hosts that can actually render it (the gg-app sidecar).
 * A subagent, a headless run or the TUI has nobody to answer, so the tool is
 * simply absent there and the agent falls back to asking in prose.
 */
export function createAskUserTool(ask: AskUserHandler): AgentTool<typeof AskUserParams> {
  return {
    name: "ask_user",
    description:
      "Ask the user a question and wait for their answer, rendered as clickable options in the " +
      "chat. THIS IS HOW YOU ASK — if a reply would otherwise end by asking them anything, ask " +
      "it here instead. That covers the decision you are blocked on (a product or taste call, a " +
      "destructive or irreversible action, a real tradeoff) AND the softer closer offering " +
      'optional follow-up work ("want me to also…?", "should I do X next?"): both are ' +
      "questions, so both belong on a clickable card rather than in prose. Do NOT use it for " +
      "anything the code, docs or a command can answer, to confirm work you were already asked " +
      "to do, or to check in on progress mid-task. No question to ask? Then do not call it — " +
      "just end the reply.\n\n" +
      "Write every question and option so a non-technical person can answer it confidently " +
      "without reading the code: plain words, no jargon, no bare file paths or symbol names, " +
      "each option describing the OUTCOME they get rather than the change you make. If two " +
      "options could look the same to someone who has not seen the code, add a `hint` saying " +
      "what each one costs. Always mark the option you would pick with `recommended`, so an " +
      "unsure user can accept your judgment in one click.\n\n" +
      "CRITICAL — every option must be a COMPLETE instruction you can act on the moment it is " +
      "clicked. A click sends that option and nothing else: the user cannot type, elaborate or " +
      "narrow it down. So never offer an option that only defers the decision back to them " +
      "('Fix something specific', 'Choose a file', 'Tell me more', 'Something else'). If you " +
      "need specifics you do not have, either find them yourself first, or list the actual " +
      "candidates as separate options. The free-text escape already exists in the UI — you do " +
      "not need to add an option for it.\n\n" +
      "This REPLACES writing the question in your reply — do not also end the message with an " +
      "asking line, and do not restate the options as text.\n\n" +
      'Good: question "Where should people\'s login sessions be stored?", options "Keep it ' +
      'simple (one file)" [recommended, hint "No extra setup, fine to a few thousand users"] ' +
      'and "Use a real database" [hint "More setup now, handles far more users"].\n' +
      'Bad: question "SQLite or Postgres for the session store?", options "SQLite", ' +
      '"Postgres" — the user cannot tell what either choice costs them.',
    parameters: AskUserParams,
    // The turn is blocked on a human; nothing else in the batch may run first.
    executionMode: "sequential",
    // The host's own timeout is the real bound. Without this the loop's 5-min
    // default would abort the call while the user is still reading the
    // question, and the answer would land on a tool call that no longer exists.
    timeoutMs: ASK_USER_TIMEOUT_MS + 30_000,
    async execute({ questions }) {
      const ids = new Set(questions.map((q) => q.id));
      if (ids.size !== questions.length) {
        return "Error: every question needs a unique `id`.";
      }
      const missing = questions.find(
        (q) => (q.kind === "choice" || q.kind === "multi") && (q.options?.length ?? 0) < 2,
      );
      if (missing) {
        return `Error: question "${missing.id}" is kind "${missing.kind}" and needs at least 2 options.`;
      }
      const deferring = questions.flatMap((q) => q.options ?? []).find(defersBack);
      if (deferring) {
        return (
          `Error: the option "${deferring.label}" asks the user to specify something, but a ` +
          "click sends only that option — they cannot type or elaborate. Replace it with the " +
          "actual choices, or find the specifics yourself first. (The free-text escape is " +
          "already built into the UI.)"
        );
      }
      const normalized = questions.map(normalize);
      return formatAskResult(normalized, await ask({ questions: normalized }));
    },
  };
}
