// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { PLAN_REVISION_FEEDBACK_MAX_CHARS } from "@kenkaiiii/gg-core";
import { describe, expect, it, vi } from "vitest";
import { PlanReviewModal } from "./PlanReviewModal";

describe("PlanReviewModal durable human gate", () => {
  it("keeps explicit human approval visible after Ken is ready", () => {
    const onAccept = vi.fn();
    const onFeedback = vi.fn();
    render(
      <PlanReviewModal
        content={"# Plan\n\n## Steps\n\n1. Verify restart recovery"}
        kenReady
        readinessReason="Corpus unavailable."
        onAccept={onAccept}
        onFeedback={onFeedback}
      />,
    );

    expect(screen.getByText(/Your approval is still required/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Corpus unavailable.");
    expect(onAccept).not.toHaveBeenCalled();
    expect(onFeedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Send feedback" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("keeps a revision-requested gate visible with a clear retry action", () => {
    const onRetryRevision = vi.fn();
    render(
      <PlanReviewModal
        content={"# Plan"}
        kenReady
        readinessReason="Corpus unavailable."
        revisionPending
        onAccept={vi.fn()}
        onFeedback={vi.fn()}
        onRetryRevision={onRetryRevision}
      />,
    );

    expect(screen.getByText(/Waiting for the revised plan snapshot/i)).toBeTruthy();
    expect(screen.queryByText("Corpus unavailable.")).toBeNull();
    expect(onRetryRevision).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Feedback" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry revision" }));
    expect(onRetryRevision).toHaveBeenCalledTimes(1);
  });

  it("does not offer a duplicate retry while the revision run is active", () => {
    render(
      <PlanReviewModal
        content={"# Plan"}
        revisionPending
        revisionRunning
        onAccept={vi.fn()}
        onFeedback={vi.fn()}
        onRetryRevision={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "Revising…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("keeps human feedback enabled while Ken is reviewing", () => {
    const onFeedback = vi.fn();
    render(
      <PlanReviewModal
        content={"# Plan"}
        kenReviewing
        onAccept={vi.fn()}
        onFeedback={onFeedback}
      />,
    );

    expect(screen.getByText(/you can still decide now/i)).toBeTruthy();
    const feedbackAction = screen.getByRole("button", { name: "Feedback" }) as HTMLButtonElement;
    expect(feedbackAction.disabled).toBe(false);
    fireEvent.click(feedbackAction);
    fireEvent.change(screen.getByPlaceholderText("What should change about this plan?"), {
      target: { value: "  Cover the review race  " },
    });
    const sendAction = screen.getByRole("button", { name: "Send feedback" }) as HTMLButtonElement;
    expect(sendAction.disabled).toBe(false);
    fireEvent.click(sendAction);
    expect(onFeedback).toHaveBeenCalledOnce();
    expect(onFeedback).toHaveBeenCalledWith("Cover the review race");
  });

  it.each([
    { length: 31_999, accepted: true },
    { length: 32_000, accepted: true },
    { length: 32_001, accepted: false },
  ])("validates $length-character feedback", ({ length, accepted }) => {
    const onFeedback = vi.fn();
    render(<PlanReviewModal content="# Plan" onAccept={vi.fn()} onFeedback={onFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));

    const input = screen.getByPlaceholderText(
      "What should change about this plan?",
    ) as HTMLTextAreaElement;
    expect(input.maxLength).toBe(PLAN_REVISION_FEEDBACK_MAX_CHARS);
    const feedback = "x".repeat(length);
    fireEvent.change(input, { target: { value: feedback } });

    const sendAction = screen.getByRole("button", {
      name: "Send feedback",
    }) as HTMLButtonElement;
    expect(sendAction.disabled).toBe(!accepted);
    fireEvent.click(sendAction);
    if (accepted) {
      expect(onFeedback).toHaveBeenCalledWith(feedback);
    } else {
      expect(onFeedback).not.toHaveBeenCalled();
      expect(screen.getByText("1 character over limit")).toBeTruthy();
    }
  });
});
