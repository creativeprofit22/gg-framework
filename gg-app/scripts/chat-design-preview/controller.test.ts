// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseSelection, startPreview } from "../../src/dev/chat-design-preview/controller";

describe("transient comparison controls", () => {
  it("allows only independent supported reading choices", () => {
    expect(parseSelection("?variant=reading&size=16&markers=on&streaming=crisp")).toMatchObject({ variant: "reading", size: "16", markers: "on", streaming: "crisp" });
    expect(() => parseSelection("?size=9")).toThrow();
    expect(() => parseSelection("?tracking=javascript:bad")).toThrow();
    expect(parseSelection("?variant=light&code=charcoal").code).toBe("charcoal");
    expect(parseSelection("?variant=light").code).toBe("light");
    expect(() => parseSelection("?code=arbitrary")).toThrow();
  });
  it("does not alter ordinary application pages", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const cleanup = startPreview();
    expect(document.querySelector("[data-chat-preview]")).toBeNull();
    expect(document.querySelector("[data-chat-preview-controls]")).toBeNull();
    cleanup();
  });
  it("applies settings without storage writes and tears down owned controls", () => {
    history.replaceState(null, "", "/__chat-design-preview?variant=reading&size=16");
    document.body.innerHTML = '<div id="root"></div>';
    const before = localStorage.length;
    const cleanup = startPreview();
    expect(document.getElementById("root")?.dataset.previewSize).toBe("16");
    expect(document.querySelectorAll("[data-chat-preview-controls] select")).toHaveLength(8);
    expect(localStorage.length).toBe(before);
    const root = document.getElementById("root")!;
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(root.dataset.previewInput).toBe("pointer");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root.dataset.previewInput).toBe("keyboard");
    cleanup();
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(root.dataset.previewInput).toBeUndefined();
    expect(document.querySelector("[data-chat-preview-controls]")).toBeNull();
    expect(document.querySelector("[data-chat-preview]")).toBeNull();
    history.replaceState(null, "", "/");
  });
});
