// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReviewDock, type ReviewDockItem } from "./ReviewDock";
import { PlanReviewModal } from "./PlanReviewModal";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/App.css", "utf8");

vi.mock("./LazyMarkdown", () => ({
  Markdown: ({ children }: { children: string }) => <p>{children}</p>,
}));

function Fixture() {
  const [expanded, setExpanded] = useState<ReviewDockItem["id"] | null>(null);
  return (
    <ReviewDock
      expanded={expanded}
      onExpandedChange={setExpanded}
      items={[
        {
          id: "plan",
          identity: "p1",
          label: "Plan approval",
          summary: "Pending",
          content: <textarea aria-label="Feedback" defaultValue="keep me" />,
        },
        {
          id: "roadmap",
          identity: "r1",
          label: "Roadmap draft",
          summary: "Two phases",
          content: <button>Create phases</button>,
        },
      ]}
    />
  );
}
describe("ReviewDock", () => {
  it("expands only the review shell and restores it without remounting feedback", () => {
    render(<Fixture />);
    expect(screen.queryByRole("button", { name: "Expand review to output area" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Plan approval/ }));
    const input = screen.getByRole("textbox", { name: "Feedback" });
    fireEvent.change(input, { target: { value: "Retain through resizing" } });
    fireEvent.click(screen.getByRole("button", { name: "Expand review to output area" }));
    expect(
      screen.getByRole("region", { name: "Pending reviews" }).classList.contains("is-maximized"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore review size" }));
    expect(
      screen.getByRole("region", { name: "Pending reviews" }).classList.contains("is-maximized"),
    ).toBe(false);
    expect(screen.getByRole("textbox", { name: "Feedback" })).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe("Retain through resizing");
    fireEvent.click(screen.getByRole("button", { name: "Expand review to output area" }));
    fireEvent.click(screen.getByRole("button", { name: /Roadmap draft/ }));
    expect(screen.queryByRole("button", { name: "Restore review size" })).toBeNull();
  });
  it("does not apply the expanded height ceiling to the complete collapsed rows", () => {
    const shell = styles.match(/\.review-dock \{([^}]+)\}/)?.[1] ?? "";
    const focused = styles.match(/\.review-dock\.is-expanded \{([^}]+)\}/)?.[1] ?? "";
    const trigger = styles.match(/\.review-dock \.review-dock-trigger \{([^}]+)\}/)?.[1] ?? "";
    expect(shell).toContain("flex: 0 0 auto");
    expect(shell).not.toMatch(/max-height|overflow:\s*auto/);
    expect(trigger).toContain("min-height: 48px");
    expect(focused).toContain("67cqh");
    expect(focused).not.toMatch(/360px|40cqh/);
  });
  it("keeps the real plan feedback mounted across collapse with controls outside its scroller", () => {
    const accept = vi.fn();
    const feedback = vi.fn();
    function PlanFixture() {
      const [expanded, setExpanded] = useState<ReviewDockItem["id"] | null>("plan");
      return (
        <ReviewDock
          expanded={expanded}
          onExpandedChange={setExpanded}
          items={[
            {
              id: "plan",
              identity: "snapshot-1",
              label: "Plan approval",
              summary: "Pending",
              content: (
                <PlanReviewModal content="A long plan" onAccept={accept} onFeedback={feedback} />
              ),
            },
          ]}
        />
      );
    }
    const { container } = render(<PlanFixture />);
    const scroller = screen.getByRole("region", { name: "Plan content" });
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.contains(screen.getByRole("button", { name: "Approve" }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    const input = screen.getByRole("textbox", { name: "Plan revision feedback" });
    fireEvent.change(input, { target: { value: "Keep this feedback" } });
    fireEvent.click(screen.getByRole("button", { name: /Plan approval.*Collapse/ }));
    expect(container.querySelector(".review-dock")?.classList.contains("is-expanded")).toBe(false);
    expect(input.isConnected).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Focus review/ }));
    expect(screen.getByRole("textbox")).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe("Keep this feedback");
    expect(accept).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });
  it("starts compact and switches a single mounted body without clearing feedback", () => {
    const { container } = render(<Fixture />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Plan approval/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my revision" } });
    fireEvent.click(screen.getByRole("button", { name: /Roadmap draft/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Create phases" })).toBeTruthy();
    expect(container.querySelectorAll(".review-dock-panel:not([hidden])")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Plan approval/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my revision");
  });
  it("returns keyboard focus on Escape without a decision", () => {
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: /Plan approval/ });
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("preserves same-identity feedback but resets a replaced checkpoint and isolates panes", () => {
    function StatefulBody() {
      const [value, setValue] = useState("");
      return (
        <input
          aria-label="Revision"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    const item = (identity: string): ReviewDockItem => ({
      id: "plan",
      identity,
      label: "Plan",
      summary: "Pending",
      content: <StatefulBody />,
    });
    const change = vi.fn();
    const { rerender } = render(
      <>
        <ReviewDock items={[item("one")]} expanded="plan" onExpandedChange={change} />
        <Fixture />
      </>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Revision" }), {
      target: { value: "keep checkpoint feedback" },
    });
    rerender(
      <>
        <ReviewDock items={[item("one")]} expanded="plan" onExpandedChange={change} />
        <Fixture />
      </>,
    );
    expect((screen.getByRole("textbox", { name: "Revision" }) as HTMLInputElement).value).toBe(
      "keep checkpoint feedback",
    );
    expect(
      screen.getByRole("button", { name: /Plan approval/ }).getAttribute("aria-expanded"),
    ).toBe("false");
    rerender(
      <>
        <ReviewDock items={[item("two")]} expanded="plan" onExpandedChange={change} />
        <Fixture />
      </>,
    );
    expect((screen.getByRole("textbox", { name: "Revision" }) as HTMLInputElement).value).toBe("");
  });
  it("uses pane-unique controls and does not grab focus on arrival", () => {
    const change = vi.fn();
    const items: ReviewDockItem[] = [
      { id: "plan", identity: "p", label: "Plan", summary: "Pending", content: "Body" },
    ];
    const { container } = render(
      <>
        <input aria-label="Composer" />
        <ReviewDock items={items} expanded={null} onExpandedChange={change} />
        <ReviewDock items={items} expanded={null} onExpandedChange={change} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(change).not.toHaveBeenCalled();
  });
});
