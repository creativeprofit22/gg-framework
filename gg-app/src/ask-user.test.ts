import { describe, expect, it } from "vitest";
import { answerAskItem, firstOpenAskId, isAskUserPrompt, type AskQuestion } from "./ask-user";

type Row = {
  kind: string;
  id: number;
  sent?: boolean;
  answeredLive?: boolean;
  cancelled?: boolean;
  answers?: Record<string, string | string[]>;
  questions?: AskQuestion[];
};

const q = (id: string): AskQuestion => ({
  id,
  kind: "choice",
  question: `${id}?`,
  options: [{ label: "Yes" }, { label: "No" }],
});

/** A question asked mid-reply, with the agent's later output below it. */
function chat(questions: AskQuestion[]): Row[] {
  return [
    { kind: "user", id: 1 },
    { kind: "assistant", id: 2 },
    { kind: "ask", id: 3, questions },
    { kind: "assistant", id: 4 },
    { kind: "tool", id: 5 },
  ];
}

function answer(
  rows: Row[],
  itemId: number,
  delta: Record<string, string | string[]>,
): { items: Row[]; completed: Record<string, string | string[]> | null } {
  let seq = 100;
  return answerAskItem(
    rows,
    itemId,
    delta,
    (it) => it.questions ?? [],
    () => ++seq,
  );
}

describe("answerAskItem", () => {
  it("moves a completed answer to the end of the conversation, as a new row", () => {
    const { items, completed } = answer(chat([q("ship")]), 3, { ship: "Yes" });
    expect(completed).toEqual({ ship: "Yes" });
    // Below everything the agent said after asking, like a sent prompt.
    expect(items.map((it) => it.kind)).toEqual(["user", "assistant", "assistant", "tool", "ask"]);
    const moved = items[items.length - 1];
    expect(moved).toMatchObject({
      kind: "ask",
      sent: true,
      answeredLive: true,
      answers: { ship: "Yes" },
    });
    // A fresh id: it is a new row, so it dissolves in rather than reusing a key.
    expect(moved?.id).toBe(101);
  });

  it("keeps a partly answered band where it was asked", () => {
    const rows = chat([q("ship"), q("notify")]);
    const { items, completed } = answer(rows, 3, { ship: "Yes" });
    expect(completed).toBeNull();
    expect(items.map((it) => it.id)).toEqual([1, 2, 3, 4, 5]);
    expect(items[2]).toMatchObject({ answers: { ship: "Yes" } });
    expect(items[2]?.sent).toBeUndefined();

    // The last answer completes it, and only then does it move.
    const done = answer(items, 3, { notify: "No" });
    expect(done.completed).toEqual({ ship: "Yes", notify: "No" });
    expect(done.items[done.items.length - 1]).toMatchObject({ kind: "ask", sent: true });
  });

  it("ignores a band that was already sent or doesn't exist", () => {
    const rows: Row[] = [{ kind: "ask", id: 3, sent: true, questions: [q("ship")] }];
    expect(answer(rows, 3, { ship: "No" })).toEqual({ items: rows, completed: null });
    expect(answer(rows, 9, { ship: "No" }).completed).toBeNull();
  });
});

describe("firstOpenAskId", () => {
  it("finds the oldest question still waiting on the user", () => {
    const rows: Row[] = [
      { kind: "ask", id: 1, sent: true },
      { kind: "ask", id: 2, cancelled: true },
      { kind: "assistant", id: 3 },
      { kind: "ask", id: 4 },
      { kind: "ask", id: 5 },
    ];
    expect(firstOpenAskId(rows)).toBe(4);
    expect(firstOpenAskId(rows.slice(0, 3))).toBeNull();
  });
});

describe("isAskUserPrompt", () => {
  it("accepts questions with and without options", () => {
    const prompt = {
      id: "ask-1",
      questions: [
        { id: "a", kind: "confirm", question: "Go?", options: [{ label: "Yes" }] },
        { id: "b", kind: "text", question: "Why?" },
      ],
    };
    expect(isAskUserPrompt(prompt)).toBe(true);
  });

  it("rejects a question whose options are not a list", () => {
    const prompt = {
      id: "ask-1",
      questions: [{ id: "a", kind: "confirm", question: "Go?", options: "[CIRCULAR]" }],
    };
    expect(isAskUserPrompt(prompt)).toBe(false);
  });
});
