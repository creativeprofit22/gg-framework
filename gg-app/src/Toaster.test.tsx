// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("./sounds", () => ({ playSound: vi.fn() }));

import { Toaster } from "./Toaster";
import { dismissToast, toast } from "./toast";

const raised: number[] = [];

afterEach(() => {
  act(() => {
    for (const id of raised.splice(0)) dismissToast(id);
  });
  cleanup();
});

describe("Toaster", () => {
  it("announces through regions that exist before any toast, errors urgently", () => {
    render(<Toaster />);
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status.textContent).toBe("");
    expect(alert.textContent).toBe("");

    act(() => {
      raised.push(toast("Saved", "success"));
      raised.push(toast("Install failed", "error"));
    });

    expect(status.textContent).toBe("Saved");
    expect(alert.textContent).toBe("Install failed");
  });
});
