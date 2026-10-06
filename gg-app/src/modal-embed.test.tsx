// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "./Modal";
import { EmbeddedModal, ModalDismissButton } from "./modal-embed";

afterEach(() => {
  cleanup();
});

function Panel({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <Modal title="Panel" onClose={onClose}>
      <p>Panel body</p>
      <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
    </Modal>
  );
}

describe("Modal embedding", () => {
  it("is a dialog with its Cancel button by default", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Panel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders as a page section inside EmbeddedModal, without dismiss controls", () => {
    render(
      <EmbeddedModal>
        <Panel onClose={vi.fn()} />
      </EmbeddedModal>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Panel" })).toBeTruthy();
    expect(screen.getByText("Panel body")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("opens a real dialog from inside an embedded page", () => {
    render(
      <EmbeddedModal>
        <Modal title="Page" onClose={vi.fn()}>
          <Modal title="Nested" onClose={vi.fn()}>
            <ModalDismissButton onClick={vi.fn()}>Cancel</ModalDismissButton>
          </Modal>
        </Modal>
      </EmbeddedModal>,
    );

    expect(screen.getByRole("region", { name: "Page" })).toBeTruthy();
    const nested = screen.getByRole("dialog", { name: "Nested" });
    // The nested dialog is a normal one: its own Cancel shows.
    expect(nested.querySelector("button.modal-btn")?.textContent).toBe("Cancel");
  });
});

describe("SettingsSection", () => {
  it("is a titled, described card on a Settings page", async () => {
    const { SettingsSection } = await import("./settings-section");
    render(
      <EmbeddedModal>
        <Modal title="Page" onClose={vi.fn()}>
          <SettingsSection title="Effects" description="Sound effects while you work.">
            <button type="button">Sound on</button>
          </SettingsSection>
        </Modal>
      </EmbeddedModal>,
    );

    const card = screen.getByRole("region", { name: "Effects" });
    expect(card.classList.contains("settings-card")).toBe(true);
    expect(card.textContent).toContain("Sound effects while you work.");
    expect(card.querySelector("button")?.textContent).toBe("Sound on");
  });

  it("keeps a dialog's plain label and hint, with no card or page description", async () => {
    const { SettingsSection } = await import("./settings-section");
    render(
      <Modal title="Settings" onClose={vi.fn()}>
        <SettingsSection
          title="Project folder"
          description="Where new projects are created."
          dialogHint={
            <div className="modal-hint">New projects are created inside this folder.</div>
          }
        >
          <input aria-label="Folder" />
        </SettingsSection>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.querySelector(".settings-card")).toBeNull();
    expect(dialog.querySelector(".modal-label")?.textContent).toBe("Project folder");
    expect(dialog.textContent).toContain("New projects are created inside this folder.");
    expect(dialog.textContent).not.toContain("Where new projects are created.");
  });
});
