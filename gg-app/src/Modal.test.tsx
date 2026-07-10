// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

function FocusModal({ onClose }: { onClose(): void }): React.ReactElement {
  const initialRef = useRef<HTMLInputElement>(null);
  return (
    <Modal title="Accessible title" onClose={onClose} initialFocusRef={initialRef}>
      <input ref={initialRef} aria-label="First field" />
      <button type="button">Last action</button>
    </Modal>
  );
}

function ClosableModal(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open modal
      </button>
      {open && <FocusModal onClose={() => setOpen(false)} />}
    </>
  );
}

describe("Modal", () => {
  it("exposes a labelled dialog and focuses the supplied initial control", () => {
    render(<FocusModal onClose={() => undefined} />);

    const dialog = screen.getByRole("dialog", { name: "Accessible title" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "First field" }));
  });

  it("wraps Tab and Shift+Tab at the focus boundaries", () => {
    render(<FocusModal onClose={() => undefined} />);
    const first = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Last action" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes by Escape and restores focus to the opener", () => {
    render(<ClosableModal />);
    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes only on the backdrop, not on mouse-down inside the dialog", () => {
    const onClose = vi.fn();
    const { container } = render(<FocusModal onClose={onClose} />);

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
