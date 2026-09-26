// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("./agent", () => ({
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
  getPermissionsStatus: vi.fn(async () => ({ applicable: false, granted: false })),
  openPermissionsSettings: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./toast", () => ({ toast: mocks.toast }));
// Instant preferences own their own persistence; they are not under test here.
vi.mock("./SoundButton", () => ({ SoundButton: () => <button>Sound</button> }));
vi.mock("./MemesButton", () => ({ MemesButton: () => <button>Memes</button> }));
vi.mock("./GgUiButton", () => ({ GgUiButton: () => <button>GG UI</button> }));
vi.mock("./AppearanceSettings", () => ({ AppearanceSettings: () => null }));
vi.mock("./AzureConnectionSettings", () => ({ AzureConnectionSettings: () => null }));

import { SettingsModal } from "./SettingsModal";

function renderModal() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<SettingsModal onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

async function folderInput(value = "/saved/projects"): Promise<HTMLInputElement> {
  const input = screen.getByLabelText("Project folder") as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe(value));
  return input;
}

const saveButton = () => screen.getByRole("button", { name: "Save folder" }) as HTMLButtonElement;

describe("SettingsModal", () => {
  beforeEach(() => {
    mocks.getSettings.mockReset();
    mocks.saveSettings.mockReset();
    mocks.toast.mockReset();
    mocks.getSettings.mockResolvedValue({ configured: true, projectsRoot: "/saved/projects" });
  });
  afterEach(cleanup);

  it("labels the folder field and explains which settings apply instantly", async () => {
    renderModal();
    const input = await folderInput();
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Applies immediately; Cancel does not undo it.")).toBeTruthy();
    expect(screen.getByText(/Save folder and Cancel apply only to this field/)).toBeTruthy();
  });

  it("disables Save folder until the folder changes", async () => {
    renderModal();
    const input = await folderInput();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "/new/projects" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("lets a first-run user save the suggested default folder unchanged", async () => {
    mocks.getSettings.mockResolvedValue({ configured: false, projectsRoot: "/default/projects" });
    mocks.saveSettings.mockResolvedValue(undefined);
    const { onClose } = renderModal();
    await folderInput("/default/projects");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings).toHaveBeenCalledWith("/default/projects");
  });

  it("saves the trimmed folder, reports it and closes", async () => {
    mocks.saveSettings.mockResolvedValue(undefined);
    const { onClose, onSaved } = renderModal();
    fireEvent.change(await folderInput(), { target: { value: "  /new/projects " } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings).toHaveBeenCalledWith("/new/projects");
    expect(onSaved).toHaveBeenCalledWith("/new/projects");
  });

  it("keeps the modal, typed value and an inline error when saving fails", async () => {
    mocks.saveSettings.mockRejectedValue(new Error("disk is read-only"));
    const { onClose, onSaved } = renderModal();
    const input = await folderInput();
    fireEvent.change(input, { target: { value: "/new/projects" } });
    fireEvent.click(saveButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't save the project folder: disk is read-only");
    expect(input.value).toBe("/new/projects");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);

    fireEvent.change(input, { target: { value: "/other" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Cancel closes without saving", async () => {
    const { onClose } = renderModal();
    fireEvent.change(await folderInput(), { target: { value: "/unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("explains a failed read instead of showing a silently blank folder", async () => {
    mocks.getSettings.mockResolvedValue(null);
    renderModal();
    expect(await screen.findByText(/Couldn\u2019t read the saved folder/)).toBeTruthy();
    expect((screen.getByLabelText("Project folder") as HTMLInputElement).value).toBe("");
  });
});
