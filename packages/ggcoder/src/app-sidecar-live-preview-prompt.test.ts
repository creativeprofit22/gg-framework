import { describe, expect, it } from "vitest";
import { prepareLivePreviewPrompt } from "./app-sidecar-live-preview-prompt.js";

const livePreview = {
  url: "http://localhost:5173/",
  element: {
    selector: "div.card > h2",
    html: "<h2>Iced latte</h2>",
    tag: "h2",
    text: "Iced latte",
  },
};

describe("live preview prompts", () => {
  it("gives the agent the element context and announces only the typed words", () => {
    const prepared = prepareLivePreviewPrompt("Change to Spanish Latte", livePreview, "/project");
    expect(prepared.text).toMatch(
      /^Change to Spanish Latte\n\n<live-preview url="http:\/\/localhost:5173\/"/,
    );
    expect(prepared.text).toContain("<h2>Iced latte</h2>");
    expect(prepared.announcement(false)).toEqual({
      text: "Change to Spanish Latte",
      element: "<h2> Iced latte",
      queued: false,
    });
  });

  it("announces a queued message as queued", () => {
    const prepared = prepareLivePreviewPrompt("Make it bold", livePreview, "/project");
    expect(prepared.text).toContain("<live-preview");
    expect(prepared.announcement(true)).toEqual({
      text: "Make it bold",
      element: "<h2> Iced latte",
      queued: true,
    });
  });

  it("leaves ordinary prompts untouched", () => {
    const prepared = prepareLivePreviewPrompt("hello", "nope", "/project");
    expect(prepared.text).toBe("hello");
    expect(prepared.announcement(false)).toBeNull();
  });
});
