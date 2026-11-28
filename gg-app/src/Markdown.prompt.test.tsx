// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendPrompt, toast } = vi.hoisted(() => ({ sendPrompt: vi.fn(), toast: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), openUrlStrict: vi.fn(), sendPrompt }));
vi.mock("./toast", () => ({ toast }));

import { Markdown, PromptSendProvider } from "./Markdown";
import { PRODUCT_DISPLAY_NAME } from "./brand";

const PROMPT = "```prompt\nAdd a retry to the upload\n```";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Ken prompt block", () => {
  it("offers the prompt again when the direct send fails", async () => {
    sendPrompt.mockRejectedValueOnce(new Error("daemon not ready"));
    render(<Markdown>{PROMPT}</Markdown>);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`send to ${PRODUCT_DISPLAY_NAME}`, "i") }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: new RegExp(`send to ${PRODUCT_DISPLAY_NAME}`, "i"),
      }).disabled,
    ).toBe(false);
  });

  it("stays sent when the App handler delivers it", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <PromptSendProvider value={onSend}>
        <Markdown>{PROMPT}</Markdown>
      </PromptSendProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`send to ${PRODUCT_DISPLAY_NAME}`, "i") }),
    );
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Add a retry to the upload"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /sent/i }).disabled).toBe(true);
  });

  it("re-enables the button when the App handler reports a failed send", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    render(
      <PromptSendProvider value={onSend}>
        <Markdown>{PROMPT}</Markdown>
      </PromptSendProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`send to ${PRODUCT_DISPLAY_NAME}`, "i") }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: new RegExp(`send to ${PRODUCT_DISPLAY_NAME}`, "i"),
        }).disabled,
      ).toBe(false),
    );
  });
});
