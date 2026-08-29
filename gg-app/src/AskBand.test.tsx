// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AskQuestion, AskUserPrompt } from "./ask-user";
import { AskBand } from "./AskBand";
import { dropSupersededAsks, mergeAskAnswers } from "./ask-user";

const prompt = (...questions: AskQuestion[]): AskUserPrompt => ({ id: "ask-1", questions });

const onTypeInstead = vi.fn();

afterEach(() => {
  cleanup();
  onTypeInstead.mockClear();
});

describe("AskBand", () => {
  it("answers a confirm with one click", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag for everyone now?",
          kind: "confirm",
          options: [
            { label: "Yes, flip it", value: "yes", recommended: true },
            { label: "Not yet", value: "no" },
          ],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Yes, flip it/ }));
    expect(onAnswer).toHaveBeenCalledWith({ flag: "yes" });
  });

  it("marks the recommendation without preselecting it", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "store",
          question: "Which store for sessions?",
          kind: "choice",
          options: [{ label: "SQLite", recommended: true }, { label: "Postgres" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    // Tagged, but nothing is chosen for the user — no pressed/checked state.
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it("returns the option's value, not its label", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "store",
          question: "Which store for sessions?",
          kind: "choice",
          options: [
            { label: "SQLite", value: "sqlite" },
            { label: "Postgres", value: "pg" },
          ],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Postgres/ }));
    expect(onAnswer).toHaveBeenCalledWith({ store: "pg" });
  });

  it("renders long labels as rows, with their hints", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "land",
          question: "How do you want to land this?",
          kind: "choice",
          options: [
            {
              label: "Fix it first, then commit & push",
              hint: "Adds about a minute, keeps the branch green",
              recommended: true,
            },
            { label: "Commit & push anyway", hint: "Issue stays open in the log" },
          ],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(document.querySelector(".ask-options.rows")).toBeTruthy();
    // Options are the app's shared pill, never a bespoke one-off control.
    expect(document.querySelectorAll(".ask-options .btn.btn-ghost").length).toBe(2);
    expect(screen.getByText("Adds about a minute, keeps the branch green")).toBeTruthy();
  });

  it("collects a multi-select and sends it as an array", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "steps",
          question: "Which steps should I run?",
          kind: "multi",
          options: [{ label: "Typecheck" }, { label: "Test suite" }, { label: "Windows smoke" }],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    const send = screen.getByRole("button", { name: /Choose at least one/ });
    expect(send).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: /Typecheck/ }));
    fireEvent.click(screen.getByRole("button", { name: /Windows smoke/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send 2 selected/ }));
    expect(onAnswer).toHaveBeenCalledWith({ steps: ["Typecheck", "Windows smoke"] });
  });

  it("sends the user to the composer instead of a second input in the transcript", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag for everyone now?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Something else/ }));
    expect(onTypeInstead).toHaveBeenCalledWith("flag");
    // No competing text field is opened inside the band.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("routes a text-only question straight to the composer", () => {
    render(
      <AskBand
        prompt={prompt({ id: "name", question: "What should I call the flag?", kind: "text" })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(onTypeInstead).toHaveBeenCalledWith("name");
  });

  it("hides the free-text escape when the agent opts out", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "go",
          question: "Run the migration against prod?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
          allowOther: false,
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(screen.queryByRole("button", { name: /Something else/ })).toBeNull();
  });

  it("accelerates with number keys, and carries a typed character to the composer", () => {
    const onAnswer = vi.fn();
    const { unmount } = render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.keyDown(document, { key: "2" });
    expect(onAnswer).toHaveBeenCalledWith({ flag: "No" });
    unmount();

    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    // A printed character means "I want to write my own answer" — it carries the
    // keystroke to the composer so the first letter is not swallowed.
    fireEvent.keyDown(document, { key: "m" });
    expect(onTypeInstead).toHaveBeenCalledWith("flag", "m");
  });

  it("never steals a keystroke meant for the composer", () => {
    const onAnswer = vi.fn();
    render(
      <>
        <textarea data-testid="composer" />
        <AskBand
          prompt={prompt({
            id: "flag",
            question: "Flip the flag?",
            kind: "confirm",
            options: [{ label: "Yes" }, { label: "No" }],
          })}
          onAnswer={onAnswer}
          onTypeInstead={onTypeInstead}
        />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId("composer"), { key: "1" });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /Your answer/ })).toBeNull();
  });

  it("reports each answered question, and only reads complete once all are in", () => {
    const onAnswer = vi.fn();
    // Controlled exactly as App drives it: the band emits a delta, the owner
    // merges, and completion is decided by the shared merge rule.
    function Controlled(): React.ReactElement {
      const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
      const p = prompt(
        {
          id: "trial",
          question: "Trial length before the first charge?",
          kind: "choice",
          options: [{ label: "14 days", recommended: true }, { label: "No trial" }],
        },
        {
          id: "proration",
          question: "Proration on mid-cycle upgrade?",
          kind: "choice",
          options: [{ label: "Prorate", recommended: true }, { label: "Charge full" }],
        },
      );
      return (
        <AskBand
          prompt={p}
          answers={answers}
          onAnswer={(delta) => {
            onAnswer(delta);
            setAnswers((c) => mergeAskAnswers(c, delta, p.questions).answers);
          }}
          onTypeInstead={onTypeInstead}
        />
      );
    }
    render(<Controlled />);

    fireEvent.click(screen.getByRole("button", { name: /No trial/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ trial: "No trial" });
    expect(screen.getByText("1 of 2 answered")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Charge full/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ proration: "Charge full" });
    expect(screen.getByText("All answered")).toBeTruthy();
  });

  it("answers every question at once from the recommendations", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt(
          {
            id: "trial",
            question: "Trial length?",
            kind: "choice",
            options: [{ label: "14 days", recommended: true }, { label: "No trial" }],
          },
          {
            id: "proration",
            question: "Proration?",
            kind: "choice",
            options: [{ label: "Prorate", recommended: true }, { label: "Charge full" }],
          },
        )}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use every recommended answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ trial: "14 days", proration: "Prorate" });
  });

  it("collapses in place once answered", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        answers={{ flag: "Yes" }}
        sent
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(document.querySelector(".ask-band.is-done")).toBeTruthy();
    // The reply is a message the user sent, so it renders as a user bubble on
    // the right, with the same shimmer as the "ideal?" hook.
    const bubble = document.querySelector(".ask-answered-bubble");
    expect(bubble).toBeTruthy();
    expect(bubble?.classList.contains("user-msg")).toBe(true);
    expect(bubble?.querySelector(".shimmer-text")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("closes the band when the run ended before an answer", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        cancelled
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/no longer needs an answer/)).toBeTruthy();
  });
});

describe("mergeAskAnswers", () => {
  const questions: AskQuestion[] = [
    { id: "a", question: "A?", kind: "confirm" },
    { id: "b", question: "B?", kind: "confirm" },
  ];

  it("stays incomplete until every question in the band has an answer", () => {
    const first = mergeAskAnswers(undefined, { a: "yes" }, questions);
    expect(first).toEqual({ answers: { a: "yes" }, complete: false });
    // Only now may the parked tool call settle — a half-filled form never lands.
    expect(mergeAskAnswers(first.answers, { b: "no" }, questions)).toEqual({
      answers: { a: "yes", b: "no" },
      complete: true,
    });
  });

  it("lets a later answer replace an earlier one for the same question", () => {
    const merged = mergeAskAnswers({ a: "yes" }, { a: "no" }, [questions[0]!]);
    expect(merged).toEqual({ answers: { a: "no" }, complete: true });
  });

  it("treats a multi-select array as one answer", () => {
    expect(mergeAskAnswers(undefined, { a: ["x", "y"] }, [questions[0]!])).toEqual({
      answers: { a: ["x", "y"] },
      complete: true,
    });
  });
});

// What a send does to the transcript. The sidecar releases the parked tool call
// as soon as the prompt lands, so a still-open band is unanswerable from that
// moment on and must not stay on screen offering buttons that reach nobody.
describe("dropSupersededAsks", () => {
  const band = (
    id: number,
    extra: Partial<{ sent: boolean; cancelled: boolean }> = {},
  ): { kind: string; id: number; sent?: boolean; cancelled?: boolean } => ({
    kind: "ask",
    id,
    ...extra,
  });

  it("drops an unanswered band when the user sends a prompt instead", () => {
    expect(dropSupersededAsks([band(1)])).toEqual([]);
  });

  it("keeps answered and cancelled bands — they are history, not live questions", () => {
    const items = [band(1, { sent: true }), band(2, { cancelled: true }), band(3)];
    expect(dropSupersededAsks(items)).toEqual([
      band(1, { sent: true }),
      band(2, { cancelled: true }),
    ]);
  });

  it("leaves every other transcript row untouched", () => {
    const items = [band(1), { kind: "user", id: 2 }, { kind: "assistant", id: 3 }];
    expect(dropSupersededAsks(items)).toEqual([
      { kind: "user", id: 2 },
      { kind: "assistant", id: 3 },
    ]);
  });
});
