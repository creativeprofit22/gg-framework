// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { pageKeyDirection, shouldPageTranscript, transcriptPageStep } from "./transcript-page-keys";

const bare = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
};

describe("pageKeyDirection", () => {
  it("maps bare Page Up / Page Down to up and down", () => {
    expect(pageKeyDirection({ ...bare, key: "PageUp" })).toBe(-1);
    expect(pageKeyDirection({ ...bare, key: "PageDown" })).toBe(1);
    expect(pageKeyDirection({ ...bare, key: "ArrowUp" })).toBeNull();
  });

  it("leaves modified, handled and composing keys alone", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(pageKeyDirection({ ...bare, key: "PageDown", [mod]: true })).toBeNull();
    }
    expect(pageKeyDirection({ ...bare, key: "PageUp", defaultPrevented: true })).toBeNull();
    expect(pageKeyDirection({ ...bare, key: "PageUp", isComposing: true })).toBeNull();
  });
});

describe("transcriptPageStep", () => {
  it("pages most of the band between the title bar and the dock", () => {
    expect(transcriptPageStep(800, 0, 0)).toBe(700);
    expect(transcriptPageStep(800, 0, 160)).toBe(560);
    expect(transcriptPageStep(800, 48, 0)).toBe(658);
    expect(transcriptPageStep(800, 48, 160)).toBe(518);
  });

  it("ignores negative insets", () => {
    expect(transcriptPageStep(800, -48, -160)).toBe(700);
  });

  it("always moves at least a little", () => {
    expect(transcriptPageStep(100, 48, 200)).toBe(40);
    expect(transcriptPageStep(0, 0, 0)).toBe(40);
  });
});

describe("shouldPageTranscript", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function pane(): { root: HTMLElement; composer: HTMLTextAreaElement } {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="transcript"><button data-t="copy">Copy</button></div>
      <textarea data-t="composer"></textarea>
      <input data-t="rename" />
      <div role="listbox"><div data-t="option" role="option"></div></div>
      <div contenteditable="true"><span data-t="editable"></span></div>`;
    document.body.append(root);
    const composer = root.querySelector<HTMLTextAreaElement>("[data-t=composer]");
    if (!composer) throw new Error("composer missing");
    return { root, composer };
  }

  it("pages from the composer, the transcript, or nothing focused", () => {
    const { root, composer } = pane();
    expect(shouldPageTranscript(composer, root, composer)).toBe(true);
    expect(shouldPageTranscript(root.querySelector("[data-t=copy]"), root, composer)).toBe(true);
    expect(shouldPageTranscript(document.body, root, composer)).toBe(true);
    expect(shouldPageTranscript(window, root, composer)).toBe(true);
  });

  it("keeps native keys for other editors, menus and other panes", () => {
    const { root, composer } = pane();
    for (const id of ["rename", "option", "editable"]) {
      expect(shouldPageTranscript(root.querySelector(`[data-t=${id}]`), root, composer)).toBe(
        false,
      );
    }
    const other = pane();
    expect(shouldPageTranscript(other.composer, root, composer)).toBe(false);
  });
});
