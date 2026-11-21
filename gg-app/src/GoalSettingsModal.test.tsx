// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { updateGoal } from "./agent";
import { GoalSettingsModal } from "./GoalSettingsModal";

vi.mock("./agent", () => ({ updateGoal: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const updateGoalMock = vi.mocked(updateGoal);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSettings(busy = false) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <GoalSettingsModal
      context={[{ path: "/repos/api", kind: "folder" }]}
      instructions="Don't touch CI."
      busy={busy}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

describe("GoalSettingsModal", () => {
  it("shows saved instructions as text to edit, and never an example in their place", () => {
    // Regression: an empty field showed New goal's example, which read as
    // instructions already saved.
    renderSettings();
    const field = screen.getByLabelText(/Instructions/) as HTMLTextAreaElement;
    expect(field.value).toBe("Don't touch CI.");
    expect(field.placeholder).toBe("None yet. Add rules for the whole goal.");
    // Adding to them keeps what was there.
    fireEvent.change(field, { target: { value: `${field.value} Ask first.` } });
    expect(field.value).toBe("Don't touch CI. Ask first.");
  });

  it("changes a goal's instructions and folders after it's created", async () => {
    const { onSaved, onClose } = renderSettings();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    // Nothing changed yet.
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Instructions/), {
      target: { value: "Ask before deleting anything." },
    });
    vi.mocked(openDialog).mockResolvedValue(["/repos/web"]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add folders" }));
    expect(await screen.findByText("web")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove api" }));

    const stored = {
      context: [{ path: "/repos/web", kind: "folder" as const }],
      instructions: "Ask before deleting anything.",
    };
    updateGoalMock.mockResolvedValue(stored);
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(stored));
    expect(updateGoalMock).toHaveBeenCalledWith({
      context: ["/repos/web"],
      instructions: "Ask before deleting anything.",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("waits while the goal is working, and shows why a save failed", async () => {
    renderSettings(true);
    expect(screen.getByText("The goal is working. Pause it to change its settings.")).toBeDefined();
    expect((screen.getByLabelText(/Instructions/) as HTMLTextAreaElement).disabled).toBe(true);
    cleanup();

    renderSettings(false);
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: "x" } });
    updateGoalMock.mockRejectedValue(new Error("This goal is still working. Pause it first."));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This goal is still working. Pause it first.",
    );
  });
});
