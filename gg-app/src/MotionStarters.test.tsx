// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MOTION_STARTERS } from "./motion-starters";
import { MotionStarters } from "./MotionStarters";

afterEach(() => {
  cleanup();
});

describe("MotionStarters", () => {
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
