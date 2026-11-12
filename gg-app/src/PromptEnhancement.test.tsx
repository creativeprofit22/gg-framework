// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EnhancedSegments, followDraftEdit, rebaseSegments, termHint } from "./PromptEnhancement";
import { TooltipLayer } from "./TooltipLayer";

describe("termHint", () => {
  it.each([
    {
      seg: { original: "type script", note: "Language name" },
      want: "you said: \u201ctype script\u201d\nLanguage name",
    },
    { seg: { original: "type script" }, want: "you said: \u201ctype script\u201d" },
  ])("formats $seg.original", ({ seg, want }) => {
    expect(termHint(seg)).toBe(want);
  });
});

describe("EnhancedSegments", () => {
  afterEach(cleanup);

  it("shows a term's hint in the app-wide tooltip, outside the message", () => {
    const { container } = render(
      <>
        <TooltipLayer />
        <p>
          <EnhancedSegments
            segments={[
              { kind: "text", text: "Use " },
              { kind: "term", text: "TypeScript", original: "type script", note: "Language name" },
            ]}
          />
        </p>
      </>,
    );
    const term = screen.getByText("TypeScript");

    fireEvent.keyDown(document, { key: "Tab" });
    act(() => {
      term.focus();
    });

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("you said: \u201ctype script\u201d\nLanguage name");
    // Portalled to the body, so the scrolling transcript can't clip it.
    expect(container.querySelector("p")?.contains(tip)).toBe(false);
    expect(term.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("shows a term's hint when it is tapped", () => {
    render(
      <>
        <TooltipLayer />
        <p>
          <EnhancedSegments
            segments={[{ kind: "term", text: "TypeScript", original: "type script" }]}
          />
        </p>
      </>,
    );
    const term = screen.getByText("TypeScript");

    fireEvent.pointerDown(term, { pointerType: "touch" });

    expect(screen.getByRole("tooltip").textContent).toBe("you said: \u201ctype script\u201d");
  });
});

describe("rebaseSegments", () => {
  const ts = { kind: "term", text: "TypeScript", original: "type script" } as const;
  const effect = { kind: "term", text: "useEffect", original: "use effect" } as const;
  const segments = [
    { kind: "text", text: "Use " },
    ts,
    { kind: "text", text: " with " },
    effect,
    { kind: "text", text: " here" },
  ] as const;
  const plain = "Use TypeScript with useEffect here";

  it.each([
    {
      name: "keeps every term when text is appended",
      next: `${plain} please`,
      want: [
        { kind: "text", text: "Use " },
        ts,
        { kind: "text", text: " with " },
        effect,
        { kind: "text", text: " here please" },
      ],
    },
    {
      name: "shifts later terms when text is inserted before them",
      next: "Now use TypeScript with useEffect here",
      want: [
        { kind: "text", text: "Now use " },
        ts,
        { kind: "text", text: " with " },
        effect,
        { kind: "text", text: " here" },
      ],
    },
    {
      name: "drops only the term an edit touches",
      next: "Use TypeScript with useLayoutEffect here",
      want: [
        { kind: "text", text: "Use " },
        ts,
        { kind: "text", text: " with useLayoutEffect here" },
      ],
    },
    {
      name: "keeps terms when the text between them is replaced",
      next: "Use TypeScript and useEffect here",
      want: [
        { kind: "text", text: "Use " },
        ts,
        { kind: "text", text: " and " },
        effect,
        { kind: "text", text: " here" },
      ],
    },
  ])("$name", ({ next, want }) => {
    const got = rebaseSegments(segments, plain, next);
    expect(got).toEqual(want);
    expect(got?.map((seg) => seg.text).join("")).toBe(next);
  });

  it("returns null when an edit removes every term", () => {
    expect(rebaseSegments(segments, plain, "Something else entirely")).toBeNull();
  });

  it("returns null when the segments don't describe the previous text", () => {
    expect(rebaseSegments(segments, "Different text", `${plain}!`)).toBeNull();
  });
});

describe("followDraftEdit", () => {
  const segments = [
    { kind: "term", text: "TypeScript", original: "type script" },
    { kind: "text", text: " rocks" },
  ] as const;
  const enhancement = {
    enhanced: "TypeScript rocks",
    plain: "TypeScript rocks",
    segments: [...segments],
  };

  it("keeps the enhancer output while following the edited draft", () => {
    expect(followDraftEdit(enhancement, "TypeScript rocks", "TypeScript rocks!")).toEqual({
      enhanced: "TypeScript rocks",
      plain: "TypeScript rocks!",
      segments: [segments[0], { kind: "text", text: " rocks!" }],
    });
  });

  it("drops a stale enhancement that no longer matches the draft", () => {
    expect(followDraftEdit(enhancement, "Other draft", "Other draft!")).toBeNull();
  });
});
