// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SidecarEvent } from "./agent";
import { hfPull, hfPullCancel, hfPullStatus, hfSearch } from "./agent";
import { HfPullModal } from "./HfPullModal";

const listeners = vi.hoisted(() => new Set<(e: SidecarEvent) => void>());

vi.mock("./agent", () => ({
  hfSearch: vi.fn(),
  hfPull: vi.fn(),
  hfPullStatus: vi.fn(),
  hfPullCancel: vi.fn(),
  // The component filters frames with this guard; mirror its check so the mock
  // factory (which replaces the whole module) keeps it working.
  isHfPullEvent: (e: SidecarEvent): boolean =>
    e.type === "hf_pull" &&
    typeof e.data === "object" &&
    e.data !== null &&
    typeof (e.data as { repo?: unknown }).repo === "string" &&
    typeof (e.data as { phase?: unknown }).phase === "string",
  subscribe: (fn: (e: SidecarEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));

const hfSearchMock = vi.mocked(hfSearch);
const hfPullMock = vi.mocked(hfPull);
const hfPullStatusMock = vi.mocked(hfPullStatus);
const hfPullCancelMock = vi.mocked(hfPullCancel);

const PULL = {
  repo: "HuggingFaceTB/SmolLM2-135M-Instruct-GGUF",
  model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
  tag: "Q4_K_M",
  file: "smollm2-135m-instruct-q4_k_m.gguf",
  sizeBytes: 86_000_000,
  phase: "preparing" as const,
  percent: 0,
};

/** Deliver one frame the way the sidecar/Rust fan-out would. */
async function emit(type: string, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    for (const fn of listeners) fn({ type, data } as SidecarEvent);
    await Promise.resolve();
  });
}

beforeEach(() => {
  listeners.clear();
  hfSearchMock.mockReset();
  hfPullMock.mockReset();
  hfPullStatusMock.mockReset().mockResolvedValue(null);
  hfPullCancelMock.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("HfPullModal search", () => {
  it("searches after typing and lists Hub repos with download counts", async () => {
    hfSearchMock.mockResolvedValue([
      { id: "Qwen/Qwen3-Coder-30B-GGUF", downloads: 2_400_000, likes: 900, updatedAt: null },
    ]);
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Search Hugging Face models" }), {
        target: { value: "qwen3 coder" },
      });
    });
    await waitFor(() => expect(hfSearchMock).toHaveBeenCalledWith("qwen3 coder"));

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Qwen/Qwen3-Coder-30B-GGUF");
    expect(option.textContent).toContain("2.4M downloads");
    expect(option.getAttribute("aria-selected")).toBe("true");
  });

  it("ignores a stored finished pull from a previous session", async () => {
    hfPullStatusMock.mockResolvedValue({ ...PULL, phase: "success", percent: 100 });
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });
    // Fresh search view, not the stale success screen.
    expect(screen.getByRole("combobox", { name: "Search Hugging Face models" })).toBeTruthy();
  });

  it("surfaces a failed search as an alert, not a silent empty list", async () => {
    hfSearchMock.mockRejectedValue(new Error("Hugging Face responded 503"));
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "llama" } });
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Hugging Face responded 503");
  });
});

describe("HfPullModal install", () => {
  it("starts the pull on click and tracks progress events to success", async () => {
    hfPullMock.mockResolvedValue({ ...PULL });
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "smollm" } });
    });
    hfSearchMock.mockResolvedValue([{ id: PULL.repo, downloads: 5, likes: 1, updatedAt: null }]);
    await waitFor(() => expect(hfSearchMock).toHaveBeenCalled());
    const option = await screen.findByRole("option");

    await act(async () => {
      fireEvent.click(option);
    });
    await waitFor(() => expect(hfPullMock).toHaveBeenCalledWith(PULL.repo));

    // Progress frames from the sidecar drive the bar.
    await emit("hf_pull", {
      ...PULL,
      phase: "downloading",
      percent: 42,
      detail: "42% 36 MB/86 MB",
    });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");

    await emit("hf_pull", { ...PULL, phase: "success", percent: 100 });
    expect(screen.getByText(/Installed/i)).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("reattaches to a pull that was already running when opened", async () => {
    hfPullStatusMock.mockResolvedValue({ ...PULL, phase: "downloading", percent: 10 });
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("maps an error frame to the failure message with a retry path", async () => {
    hfPullMock.mockResolvedValue({ ...PULL });
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "smollm" } });
    });
    hfSearchMock.mockResolvedValue([{ id: PULL.repo, downloads: 5, likes: 1, updatedAt: null }]);
    const option = await screen.findByRole("option");
    await act(async () => {
      fireEvent.click(option);
    });
    await emit("hf_pull", {
      ...PULL,
      phase: "error",
      error:
        "This Ollama version can't pull from Hugging Face (a 0.32 manifest bug). Upgrade Ollama, then try again.",
    });
    expect(screen.getByRole("alert").textContent).toContain("Upgrade Ollama");

    // Back to search for the next attempt.
    await act(async () => {
      fireEvent.click(screen.getByText("Download another"));
    });
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("cancel button asks the sidecar to kill the child process", async () => {
    hfPullStatusMock.mockResolvedValue({ ...PULL, phase: "downloading", percent: 5 });
    await act(async () => {
      render(<HfPullModal onClose={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel download"));
    });
    expect(hfPullCancelMock).toHaveBeenCalledOnce();
  });
});
