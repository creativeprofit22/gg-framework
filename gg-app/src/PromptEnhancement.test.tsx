// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EnhancedSegments, termHint } from "./PromptEnhancement";
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
