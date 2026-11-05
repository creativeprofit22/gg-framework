// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openProjectPath, readChatImage } = vi.hoisted(() => ({
  openProjectPath: vi.fn(),
  readChatImage: vi.fn(),
}));
vi.mock("./agent", () => ({ openProjectPath, readChatImage }));

import { ToolImageCard } from "./ToolImageCard";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ToolImageCard", () => {
  it("shows an image that still has its data without reading the file", () => {
    render(<ToolImageCard image={{ src: PNG, path: "/shots/new.png" }} paneId="pane-a" />);
    expect(screen.getByRole("img", { name: "/shots/new.png" }).getAttribute("src")).toBe(PNG);
    expect(readChatImage).not.toHaveBeenCalled();
  });

  it("reloads a trimmed image from its path through the pane", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(<ToolImageCard image={{ path: "/shots/old.png" }} paneId="pane-a" />);
    expect(screen.getByRole("status").textContent).toBe("Loading image…");
    const img = await screen.findByRole("img", { name: "/shots/old.png" });
    expect(img.getAttribute("src")).toBe(PNG);
    expect(readChatImage).toHaveBeenCalledWith("/shots/old.png", "pane-a", "path");
  });

  it("reloads a trimmed image with URL-like characters as a literal path", async () => {
    readChatImage.mockResolvedValue(PNG);
    const path = "/shots/issue #42 100%25.png";
    render(<ToolImageCard image={{ path }} paneId="pane-a" />);
    expect(await screen.findByRole("img", { name: path })).toBeTruthy();
    expect(readChatImage).toHaveBeenCalledWith(path, "pane-a", "path");
  });

  it("shows 'Image unavailable' for a missing file and still opens it on click", async () => {
    readChatImage.mockResolvedValue(null);
    render(<ToolImageCard image={{ path: "/shots/gone.png" }} paneId="pane-a" />);
    expect(await screen.findByText("Image unavailable")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByTitle("Open /shots/gone.png"));
    expect(openProjectPath).toHaveBeenCalledWith("/shots/gone.png", "pane-a");
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(openProjectPath).toHaveBeenCalledTimes(2);
  });

  it("shows 'Image unavailable' when the loaded data won't render", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(<ToolImageCard image={{ path: "/shots/bad.png" }} paneId="pane-a" />);
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByText("Image unavailable")).toBeTruthy();
  });
});
