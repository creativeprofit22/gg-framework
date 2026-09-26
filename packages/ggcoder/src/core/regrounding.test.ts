import { describe, expect, it } from "vitest";
import {
  buildRegroundingMessage,
  requestTextForRegrounding,
  shouldReground,
} from "./regrounding.js";

describe("requestTextForRegrounding", () => {
  it("keeps plain string requests verbatim", () => {
    expect(requestTextForRegrounding({ role: "user", content: "Fix the login bug" })).toBe(
      "Fix the login bug",
    );
  });

  it("keeps the text of attachment messages and notes media by kind only", () => {
    const text = requestTextForRegrounding({
      role: "user",
      content: [
        { type: "text", text: "Match this mockup" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "text", text: "but keep the header" },
        { type: "image", mediaType: "image/png", data: "BBBB" },
      ],
    });
    expect(text).toBe("Match this mockup\nbut keep the header\n\n[Attached: 2 images]");
    expect(text).not.toContain("AAAA");
  });

  it("returns empty for a missing message", () => {
    expect(requestTextForRegrounding(undefined)).toBe("");
  });
});

describe("shouldReground", () => {
  it("fires once after a compaction occurs", () => {
    expect(shouldReground({ compactionOccurred: true, alreadyInjected: false })).toBe(true);
  });

  it("does not fire when no compaction has happened", () => {
    expect(shouldReground({ compactionOccurred: false, alreadyInjected: false })).toBe(false);
  });

  it("does not fire twice for the same compaction", () => {
    expect(shouldReground({ compactionOccurred: true, alreadyInjected: true })).toBe(false);
  });
});

describe("buildRegroundingMessage", () => {
  it("pins the original request verbatim", () => {
    const original = "Rename the qty field to quantity everywhere in inventory.ts";
    const message = buildRegroundingMessage(original);
    expect(message.role).toBe("user");
    expect(message.content).toContain("Re-ground");
    expect(message.content).toContain(original);
  });

  it("explains that context was compacted and warns against drift", () => {
    const content = buildRegroundingMessage("do the thing").content as string;
    expect(content).toContain("compacted");
    expect(content.toLowerCase()).toContain("drift");
  });

  it("does not instruct the model to narrate the note", () => {
    const content = buildRegroundingMessage("do the thing").content as string;
    expect(content.toLowerCase()).toContain("do not restate");
  });

  it("trims whitespace and tolerates an empty original request", () => {
    const message = buildRegroundingMessage("   ");
    expect(message.role).toBe("user");
    expect(message.content).toContain("Re-ground");
    expect(message.content).not.toContain('""');
  });
});
