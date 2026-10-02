// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MOTION_STARTERS } from "./motion-starters";
import { MotionStarters } from "./MotionStarters";

afterEach(() => {
  cleanup();
});

describe("MotionStarters", () => {
  it("offers plain, one-line from-scratch video ideas the user finishes in their own words", () => {
    expect(MOTION_STARTERS.map(({ label }) => label)).toEqual([
      "Make a product launch",
      "Make an explainer",
      "Make a social ad",
      "Make animated titles",
    ]);
    for (const { label, prompt } of MOTION_STARTERS) {
      // Motion designs videos from scratch: every chip starts a new video, none edits one.
      expect(label).toMatch(/^Make /);
      expect(label).not.toMatch(/edit|logo reveal/i);
      // The agent owns design, quality and workflow; the chip only states the job.
      expect(prompt.length).toBeLessThan(60);
      expect(prompt).toMatch(/: $/);
      expect(prompt).not.toMatch(
        /skill|recipe|template|choreograph|render|mixkit|launch kit|30-second|new art direction/i,
      );
    }
  });
  it.each(MOTION_STARTERS)(
    "fills the composer with $label without submitting",
    ({ label, prompt }) => {
      const onPick = vi.fn();
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <MotionStarters onPick={onPick} />
        </form>,
      );

      expect(screen.getAllByRole("button")).toHaveLength(MOTION_STARTERS.length);
      expect(onPick).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(onPick).toHaveBeenCalledOnce();
      expect(onPick).toHaveBeenCalledWith(prompt);
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );
});
