// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { withViewTransition } from "./view-transition";

vi.mock("./view-transition", () => ({
  withViewTransition: vi.fn((update: () => void) => update()),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Modal", () => {
  it("restores background interaction when nested dialogs unmount together on project change", () => {
    const background = document.createElement("button");
    document.body.append(background);
    const view = render(
      <Modal title="Outer" onClose={() => {}}>
        <span>Notes</span>
      </Modal>,
    );
    view.rerender(
      <Modal title="Outer" onClose={() => {}}>
        <Modal title="Inner" onClose={() => {}}>
          <button>Cancel</button>
        </Modal>
      </Modal>,
    );
    expect(background.inert).toBe(true);
    view.unmount();
    expect(background.inert).not.toBe(true);
    background.remove();
  });
  it.each(["Escape", "Close", "Cancel", "backdrop"])(
    "uses one dismissal transition for %s",
    (path) => {
      const onClose = vi.fn();
      render(
        <Modal title="Evidence" onClose={onClose}>
          <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
        </Modal>,
      );
      if (path === "Escape") fireEvent.keyDown(document, { key: "Escape" });
      else if (path === "backdrop") {
        const backdrop = document.querySelector(".modal-backdrop");
        if (!backdrop) throw new Error("Missing backdrop");
        fireEvent.mouseDown(backdrop);
      } else fireEvent.click(screen.getByRole("button", { name: path }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(withViewTransition).toHaveBeenCalledOnce();
    },
  );

  it("keeps the title-only header markup when no description is given", () => {
    render(
      <Modal title="Plain" onClose={() => {}}>
        <span>Body</span>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Plain" });
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
    const head = dialog.querySelector(".modal-head");
    expect(head?.querySelector(".modal-head-text")).toBeNull();
    expect(head?.firstElementChild?.matches("h2.modal-title")).toBe(true);
    expect(head?.lastElementChild?.getAttribute("aria-label")).toBe("Close");
  });

  it("describes the dialog with header text without changing its name", () => {
    render(
      <Modal
        title="Your notes"
        description={<span>alpha · 1 of 2 phases done</span>}
        onClose={() => {}}
      >
        <span>Body</span>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Your notes" });
    const id = dialog.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const described = id ? document.getElementById(id) : null;
    expect(described?.textContent).toBe("alpha · 1 of 2 phases done");
    const head = dialog.querySelector(".modal-head");
    expect(head?.firstElementChild?.classList.contains("modal-head-text")).toBe(true);
    expect(head?.lastElementChild?.getAttribute("aria-label")).toBe("Close");
  });

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
