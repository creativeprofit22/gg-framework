// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openUrl, openProjectPath, readChatImage } = vi.hoisted(() => ({
  openUrl: vi.fn(),
  openProjectPath: vi.fn(),
  readChatImage: vi.fn(),
}));
// Local Fork: external links go through openUrlStrict; local files route by pane.
vi.mock("./agent", () => ({
  openProjectPath,
  openUrlStrict: openUrl,
  readChatImage,
  sendPrompt: vi.fn(),
}));

import { Markdown } from "./Markdown";
import { PaneIdProvider } from "./pane-context";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("markdown images", () => {
  it("shows a local image path by reading the file through the app", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(<Markdown>{"![transcript](/tmp/gg-shell-mock/transcript.png)"}</Markdown>);
    const img = await screen.findByRole("img", { name: "transcript" });
    expect(img.getAttribute("src")).toBe(PNG);
    expect(readChatImage).toHaveBeenCalledWith("/tmp/gg-shell-mock/transcript.png", "primary");
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    expect(openProjectPath).toHaveBeenCalledWith(
      "/tmp/gg-shell-mock/transcript.png",
      "primary",
      "url",
    );
  });

  it("keeps file:// sources instead of blanking them", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(<Markdown>{"![shot](file:///tmp/shot.png)"}</Markdown>);
    await screen.findByRole("img", { name: "shot" });
    expect(readChatImage).toHaveBeenCalledWith("file:///tmp/shot.png", "primary");
  });

  it("shows a link to the file, not a broken image, when it can't be read", async () => {
    readChatImage.mockResolvedValue(null);
    render(<Markdown>{"![mock](/tmp/missing.png)"}</Markdown>);
    expect(await screen.findByText(/Couldn't show image/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByText("mock"));
    // The fallback is a regular chat link, which loads its opener lazily.
    await waitFor(() =>
      expect(openProjectPath).toHaveBeenCalledWith("/tmp/missing.png", "primary", "url"),
    );
  });

  it("falls back to a link for web images, which the app's CSP blocks", () => {
    render(<Markdown>{"![chart](https://example.com/chart.png)"}</Markdown>);
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByText("chart"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/chart.png");
    expect(readChatImage).not.toHaveBeenCalled();
  });

  it("keeps Windows drive image paths and reads them against the originating pane", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(
      <PaneIdProvider value="pane-2">
        <Markdown>{"![win](E:/Projects/shot.png)"}</Markdown>
      </PaneIdProvider>,
    );
    await screen.findByRole("img", { name: "win" });
    expect(readChatImage).toHaveBeenCalledWith("E:/Projects/shot.png", "pane-2");
    fireEvent.click(screen.getByRole("button", { name: "Open win" }));
    expect(openProjectPath).toHaveBeenCalledWith("E:/Projects/shot.png", "pane-2", "url");
  });

  it("renders data: images directly", () => {
    render(<Markdown>{`![dot](${PNG})`}</Markdown>);
    expect(screen.getByRole("img", { name: "dot" }).getAttribute("src")).toBe(PNG);
    expect(readChatImage).not.toHaveBeenCalled();
  });
});
