// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";

afterEach(cleanup);

const entries: LiveToolEntry[] = [
  {
    toolCallId: "success-call",
    name: "mcp__id__success",
    displayName: "fixture / success",
    args: {},
    status: "done",
    isError: false,
    result: "ok",
  },
  {
    toolCallId: "thrown-call",
    name: "mcp__id__thrown",
    displayName: "fixture / thrown",
    args: {},
    status: "done",
    isError: true,
    result: "transport exploded",
  },
  {
    toolCallId: "reported-call",
    name: "mcp__id__reported",
    displayName: "fixture / reported",
    args: {},
    status: "done",
    isError: true,
    result: "server rejected the call",
  },
];

describe("LiveToolPanel completion status", () => {
  it.each([
    [
      "Image generation failed: OpenAI Image API (400): unsupported tool",
      "Image generation failed: OpenAI Image API (…",
    ],
    [
      "Image generation failed: Astra image request failed (response.failed).",
      "Image generation failed: Astra image reques…",
    ],
    [
      "Image generation returned no image results from GPT-6 Astra. No fallback model was used.",
      "Image generation returned no image results …",
    ],
    [
      "OpenAI is not connected. Connect OpenAI to use image generation.",
      "OpenAI is not connected. Connect OpenAI to …",
    ],
    ["Image generation aborted.", "Image generation aborted."],
  ])("shows image failure instead of completion: %s", (result, preview) => {
    render(
      <LiveToolPanel
        entries={[
          {
            toolCallId: "image",
            name: "generate_image",
            args: { prompt: "a cat" },
            status: "done",
            isError: true,
            result,
          },
        ]}
      />,
    );
    const pill = document.querySelector<HTMLElement>(".tool-pill");
    expect(pill?.dataset.state).toBe("error");
    expect(screen.getByText("Failed:").classList.contains("visually-hidden")).toBe(true);
    expect(screen.queryByText("Completed:")).toBeNull();
    expect(screen.getByText(`· ${preview}`)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(preview);
  });

  it("shows success, thrown failure, and MCP isError failure with accessible status text", () => {
    // Upstream's pill shows only the current step, so each outcome is rendered on its own.
    const expected = [
      ["fixture / success", "done", "Completed:"],
      ["fixture / thrown", "error", "Failed:"],
      ["fixture / reported", "error", "Failed:"],
    ] as const;
    for (const [index, entry] of entries.entries()) {
      const [label, state, spoken] = expected[index] ?? ["", "", ""];
      const { unmount } = render(<LiveToolPanel entries={[entry]} />);
      const pill = document.querySelector<HTMLElement>(".tool-pill");
      expect(pill?.dataset.state).toBe(state);
      expect(screen.getByText(spoken).classList.contains("visually-hidden")).toBe(true);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("shows only the newest finished step when none is running", () => {
    render(<LiveToolPanel entries={entries} />);
    expect(screen.getByText("fixture / reported")).toBeTruthy();
    expect(screen.queryByText("fixture / success")).toBeNull();
    expect(screen.getByText("Failed:")).toBeTruthy();
  });
});
