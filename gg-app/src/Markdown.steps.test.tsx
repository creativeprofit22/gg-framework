// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(),
  sendPrompt: vi.fn(),
}));

import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("numbered steps", () => {
  it("starts a list's step counter at 1", () => {
    const { container } = render(<Markdown>{"1. Install\n2. Run"}</Markdown>);
    const list = container.querySelector("ol");
    expect(list?.style.counterReset).toBe("step 0");
    expect(list?.hasAttribute("start")).toBe(false);
  });

  it("keeps counting when a list continues after a code block", () => {
    const text = ["1. Install", "2. Build", "", "```sh", "pnpm build", "```", "", "3. Run it"].join(
      "\n",
    );
    const { container } = render(<Markdown>{text}</Markdown>);
    const lists = container.querySelectorAll("ol");
    expect(lists).toHaveLength(2);
    expect(lists[1]?.getAttribute("start")).toBe("3");
    // The CSS counter increments before each row, so 2 here labels the row 3.
    expect(lists[1]?.style.counterReset).toBe("step 2");
  });
});
