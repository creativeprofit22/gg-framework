// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowFocused } from "./useWindowFocused";

function Probe(): React.ReactElement {
  return <div data-testid="focused">{String(useWindowFocused())}</div>;
}

afterEach(() => vi.restoreAllMocks());

describe("useWindowFocused", () => {
  it("starts unfocused when the document is not focused at mount", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<Probe />);
    expect(screen.getByTestId("focused").textContent).toBe("false");
  });

  it("starts focused when the document is focused at mount", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Probe />);
    expect(screen.getByTestId("focused").textContent).toBe("true");
  });

  it("follows window focus/blur events after mount", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<Probe />);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(screen.getByTestId("focused").textContent).toBe("true");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(screen.getByTestId("focused").textContent).toBe("false");
  });
});
