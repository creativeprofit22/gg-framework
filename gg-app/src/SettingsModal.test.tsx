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
  // The Power section's Keep awake switch reads and saves through the sidecar.
  getKeepAwake: vi.fn(async (): Promise<boolean> => true),
  setKeepAwake: vi.fn(async (enabled: boolean): Promise<boolean> => enabled),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./toast", () => ({ toast: mocks.toast }));
// Instant preferences own their own persistence; they are not under test here.
vi.mock("./SoundButton", () => ({ SoundButton: () => <button>Sound</button> }));
vi.mock("./HomeBackgroundButton", () => ({
  HomeBackgroundButton: () => <button>Background</button>,
}));
vi.mock("./AppearanceSettings", () => ({ AppearanceSettings: () => null }));
vi.mock("./AzureConnectionSettings", () => ({ AzureConnectionSettings: () => null }));

import { SettingsModal } from "./SettingsModal";
import { EmbeddedModal } from "./modal-embed";
import { SettingsHeaderProvider } from "./settings-header";

function renderModal() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<SettingsModal onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

/** The Settings page's General tab: embedded, with live header slots. */
function renderPage() {
  const onClose = vi.fn();
  const status = document.createElement("span");
  const actions = document.createElement("span");
  document.body.append(status, actions);
  render(
    <SettingsHeaderProvider slots={{ status, actions }}>
      <EmbeddedModal>
        <SettingsModal onClose={onClose} />
      </EmbeddedModal>
    </SettingsHeaderProvider>,
  );
  return { onClose, actions, status };
}

async function folderInput(value = "/saved/projects"): Promise<HTMLInputElement> {
  // On the page the card <section> shares the name, so ask for the field.
  const input = screen.getByRole("textbox", { name: "Project folder" }) as HTMLInputElement;
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
    const hintId = input.getAttribute("aria-describedby")?.split(" ")[0] ?? "";
    expect(document.getElementById(hintId)?.textContent).toBe(
      "New projects are created inside this folder. Choose Save folder to keep a change.",
    );
    expect(
      screen.getByText("Sound and the home screen's moving background. Changes apply right away."),
    ).toBeTruthy();
    // Nothing claims a Cancel that does not undo; there is no Cancel at all.
    expect(screen.queryByText(/does not undo/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("disables Save folder until the folder changes and keeps it beside the field", async () => {
    renderModal();
    const input = await folderInput();
    expect(saveButton().closest(".modal-row")?.contains(input)).toBe(true);
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
    expect((await screen.findByRole("status")).textContent).toBe("Folder saved.");
    expect(mocks.saveSettings).toHaveBeenCalledWith("/default/projects");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves the trimmed folder, confirms inline and stays open", async () => {
    mocks.saveSettings.mockResolvedValue(undefined);
    const { onClose, onSaved } = renderModal();
    const input = await folderInput();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    fireEvent.change(input, { target: { value: "  /new/projects " } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(status.textContent).toBe("Folder saved."));
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(mocks.saveSettings).toHaveBeenCalledWith("/new/projects");
    expect(onSaved).toHaveBeenCalledWith("/new/projects");
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText("Not saved yet.")).toBeNull();

    // The next edit retracts the confirmation.
    fireEvent.change(input, { target: { value: "/newer" } });
    expect(status.textContent).toBe("");
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
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't save: disk is read-only", "error");
    expect(saveButton().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");

    fireEvent.change(input, { target: { value: "/other" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("Retry saves the kept value after a failure", async () => {
    mocks.saveSettings
      .mockRejectedValueOnce(new Error("disk is read-only"))
      .mockResolvedValueOnce(undefined);
    const { onClose, onSaved } = renderModal();
    const input = await folderInput();
    fireEvent.change(input, { target: { value: "/new/projects" } });
    fireEvent.click(saveButton());
    await screen.findByRole("alert");
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Folder saved."));
    expect(mocks.saveSettings).toHaveBeenNthCalledWith(2, "/new/projects");
    expect(onSaved).toHaveBeenCalledWith("/new/projects");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("warns about an unsaved edit, and Close closes without saving", async () => {
    const { onClose } = renderModal();
    const input = await folderInput();
    expect(screen.queryByText("Not saved yet.")).toBeNull();
    fireEvent.change(input, { target: { value: "/unsaved" } });
    const pending = screen.getByText("Not saved yet.");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(pending.id);
    // The footer's Close (the corner ✕ shares the name and the action).
    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((b) => b.closest(".modal-actions"));
    expect(close?.textContent).toBe("Close");
    fireEvent.click(close as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("renders the same sections and save control on the Settings page", async () => {
    renderModal();
    await folderInput();
    const dialogSections = [...document.querySelectorAll(".modal-label")].map(
      (el) => el.textContent,
    );
    cleanup();

    mocks.saveSettings.mockResolvedValue(undefined);
    const { onClose, actions, status } = renderPage();
    const input = await folderInput();
    const pageSections = [...document.querySelectorAll(".settings-section-title")].map(
      (el) => el.textContent,
    );
    expect(pageSections).toEqual(["Effects", "Power", "Project folder"]);
    expect(pageSections).toEqual(dialogSections);
    // No Close on the page (Back leaves), and Save folder is not in the header.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(actions.childElementCount).toBe(0);
    expect(saveButton().closest(".modal-row")?.contains(input)).toBe(true);
    expect(screen.queryByText(/does not undo/)).toBeNull();

    fireEvent.change(input, { target: { value: "/page/projects" } });
    expect(screen.getByText("Not saved yet.")).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Folder saved."));
    expect(saveButton().disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    actions.remove();
    status.remove();
  });

  it("explains a failed read instead of showing a silently blank folder", async () => {
    mocks.getSettings.mockResolvedValue(null);
    renderModal();
    expect(await screen.findByText(/Couldn\u2019t read the saved folder/)).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Project folder" }) as HTMLInputElement).value,
    ).toBe("");
  });
});
