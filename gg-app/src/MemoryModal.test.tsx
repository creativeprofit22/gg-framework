// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  deleteJiwa,
  deleteMemory,
  isJiwaChangeEvent,
  isMemoryChangeEvent,
  listJiwa,
  listMemories,
  subscribe,
  type JiwaSnapshot,
  type MemorySnapshot,
  type SidecarEvent,
} from "./agent";
import { MemoryModal } from "./MemoryModal";

let eventHandler: ((event: SidecarEvent) => void) | undefined;

vi.mock("./agent", () => ({
  deleteJiwa: vi.fn(),
  deleteMemory: vi.fn(),
  listJiwa: vi.fn(),
  listMemories: vi.fn(),
  subscribe: vi.fn((handler: (event: SidecarEvent) => void) => {
    eventHandler = handler;
    return vi.fn();
  }),
  isJiwaChangeEvent: vi.fn((event: SidecarEvent) => event.type === "jiwa_change"),
  isMemoryChangeEvent: vi.fn((event: SidecarEvent) => event.type === "memory_change"),
}));

const listMemoriesMock = vi.mocked(listMemories);
const deleteMemoryMock = vi.mocked(deleteMemory);
const listJiwaMock = vi.mocked(listJiwa);
const deleteJiwaMock = vi.mocked(deleteJiwa);
const subscribeMock = vi.mocked(subscribe);
const isMemoryChangeEventMock = vi.mocked(isMemoryChangeEvent);
const isJiwaChangeEventMock = vi.mocked(isJiwaChangeEvent);

const populatedMemories: MemorySnapshot = {
  softLimit: 60,
  hardLimit: 90,
  memories: [
    {
      id: "memory-1",
      text: "Ken prefers concise, scannable answers.",
      category: "preference",
      importance: 5,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    },
  ],
};

const populatedJiwa: JiwaSnapshot = {
  softLimit: 60,
  hardLimit: 90,
  jiwa: [
    {
      id: "jiwa-1",
      text: "Call yourself Blargo in chat.",
      category: "identity",
      importance: 5,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  eventHandler = undefined;
  listMemoriesMock.mockResolvedValue(populatedMemories);
  deleteMemoryMock.mockResolvedValue({ ...populatedMemories, memories: [] });
  listJiwaMock.mockResolvedValue(populatedJiwa);
  deleteJiwaMock.mockResolvedValue({ ...populatedJiwa, jiwa: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryModal", () => {
  it("presents memories and Jiwa as accessible Brain tabs", async () => {
    render(<MemoryModal onClose={vi.fn()} />);

    expect(await screen.findByText("Ken prefers concise, scannable answers.")).toBeDefined();
    const title = document.querySelector(".memory-modal-title");
    expect(title?.textContent).toContain("Brain");
    expect(title?.querySelector(".badge")?.textContent).toBe("1");
    expect(screen.getByRole("tab", { name: "Memories" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: "Jiwa" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("preference")).toBeDefined();
    expect(screen.getByLabelText("Importance 5 of 5")).toBeDefined();
  });

  it("switches the table and total badge to Jiwa by click or arrow key", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText("Ken prefers concise, scannable answers.");
    const memoriesTab = screen.getByRole("tab", { name: "Memories" });

    fireEvent.keyDown(memoriesTab, { key: "ArrowRight" });

    expect(await screen.findByText("Call yourself Blargo in chat.")).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Instruction" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Jiwa" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("1");
  });

  it("deletes exactly one entry from the active table", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText("Ken prefers concise, scannable answers.");
    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    const button = await screen.findByRole("button", {
      name: "Delete Jiwa instruction: Call yourself Blargo in chat.",
    });

    fireEvent.click(button);

    await waitFor(() => expect(deleteJiwaMock).toHaveBeenCalledWith("jiwa-1"));
    expect(deleteMemoryMock).not.toHaveBeenCalled();
    expect(await screen.findByText("No Jiwa instructions yet.")).toBeDefined();
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("0");
  });

  it("renders a load error for the active table", async () => {
    listMemoriesMock.mockRejectedValue(new Error("daemon unavailable"));
    render(<MemoryModal onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t load memories: daemon unavailable",
    );
  });

  it("refreshes each table from its matching change event", async () => {
    const refreshedMemories: MemorySnapshot = {
      ...populatedMemories,
      memories: [
        ...populatedMemories.memories,
        {
          ...populatedMemories.memories[0]!,
          id: "memory-2",
          text: "Ken is building durable chat memory.",
          category: "project",
        },
      ],
    };
    const refreshedJiwa: JiwaSnapshot = {
      ...populatedJiwa,
      jiwa: [
        ...populatedJiwa.jiwa,
        {
          ...populatedJiwa.jiwa[0]!,
          id: "jiwa-2",
          text: "Never end with a generic offer to help.",
          category: "boundaries",
        },
      ],
    };
    listMemoriesMock
      .mockResolvedValueOnce(populatedMemories)
      .mockResolvedValueOnce(refreshedMemories);
    listJiwaMock.mockResolvedValueOnce(populatedJiwa).mockResolvedValueOnce(refreshedJiwa);
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText("Ken prefers concise, scannable answers.");

    eventHandler?.({ type: "memory_change", data: { count: 2 } });
    expect(await screen.findByText("Ken is building durable chat memory.")).toBeDefined();
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("2");

    eventHandler?.({ type: "jiwa_change", data: { count: 2 } });
    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    expect(await screen.findByText("Never end with a generic offer to help.")).toBeDefined();
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("2");
    expect(isMemoryChangeEventMock).toHaveBeenCalled();
    expect(isJiwaChangeEventMock).toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalledOnce();
  });
});
