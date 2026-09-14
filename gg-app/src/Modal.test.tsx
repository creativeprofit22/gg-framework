// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal", () => {
  it("exposes dialog semantics, closes on Escape, and returns focus", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <Modal title="Evidence" onClose={onClose}>
        <button type="button" data-modal-initial-focus>
          First action
        </button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Evidence" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "First action" })).toBe(document.activeElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("contains Tab focus and only dismisses from the backdrop itself", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Evidence" onClose={onClose}>
        <button type="button" data-modal-initial-focus>
          First
        </button>
        <button type="button">Last</button>
      </Modal>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("skips controls hidden by ancestors when wrapping focus in both directions", () => {
    render(
      <Modal title="Evidence" onClose={vi.fn()}>
        <button type="button" data-modal-initial-focus>
          First visible
        </button>
        <button type="button">Last visible</button>
        <section hidden>
          <button type="button">Hidden panel action</button>
        </section>
        <section aria-hidden="true">
          <button type="button">Aria-hidden action</button>
        </section>
        <section inert>
          <button type="button">Inert action</button>
        </section>
        <section role="tabpanel" style={{ display: "none" }}>
          <button type="button">Non-rendered panel action</button>
        </section>
      </Modal>,
    );

    const first = screen.getByRole("button", { name: "First visible" });
    const last = screen.getByRole("button", { name: "Last visible" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("focuses the selected tab and uses the latest close callback", () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const content = (onClose: () => void): React.ReactElement => (
      <Modal title="Brain" onClose={onClose}>
        <div role="tablist" aria-label="Memory type">
          <button type="button" role="tab" aria-selected="true">
            Memories
          </button>
          <button type="button" role="tab" aria-selected="false" tabIndex={-1}>
            Jiwa
          </button>
        </div>
      </Modal>
    );
    const { rerender } = render(content(firstClose));

    expect(screen.getByRole("tab", { name: "Memories" })).toBe(document.activeElement);
    rerender(content(latestClose));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledOnce();
  });
});
