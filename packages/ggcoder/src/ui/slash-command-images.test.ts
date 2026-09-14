import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "../utils/image.js";
import { buildUserContentWithAttachments, routePromptCommandInput } from "./prompt-routing.js";

describe("prompt-template slash commands with attachments", () => {
  it("routes /expand input to a wrapper containing user args", () => {
    const route = routePromptCommandInput("/expand do X");

    expect(route).not.toBeNull();
    expect(route?.cmdName).toBe("expand");
    expect(route?.cmdArgs).toBe("do X");
    expect(route?.fullPrompt).toContain(route?.promptText);
    expect(route?.fullPrompt).toContain("## User Instructions");
    expect(route?.fullPrompt).toContain("do X");
  });

  it("routes markdown and multiline text without losing rendered edge cases", () => {
    const args = "prove **bold** UI renders\n- keep `code` text\n- wrap very long labels";
    const route = routePromptCommandInput(`/expand ${args}`);

    expect(route).toMatchObject({ cmdName: "expand", cmdArgs: args });
    expect(route?.fullPrompt).toContain(`## User Instructions\n\n${args}`);
    expect(route?.fullPrompt).toContain("**bold** UI renders");
    expect(route?.fullPrompt).toContain("`code` text");
  });

  it("does not route an unknown command", () => {
    expect(routePromptCommandInput("/not-a-command do X")).toBeNull();
  });

  it("builds multimodal user content with the full prompt text and image block", () => {
    const fullPrompt = "Command prompt\n\n## User Instructions\n\ndo X";
    const imageAttachment: ImageAttachment = {
      kind: "image",
      fileName: "screenshot.png",
      filePath: "/tmp/screenshot.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    };

    const content = buildUserContentWithAttachments(fullPrompt, [imageAttachment], true, false);

    expect(content).toEqual([
      { type: "text", text: fullPrompt },
      { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
    ]);
  });

  it("wraps text attachments in file-tag text blocks", () => {
    const textAttachment: ImageAttachment = {
      kind: "text",
      fileName: "notes.txt",
      filePath: "/tmp/notes.txt",
      mediaType: "text/plain",
      data: "important context",
    };

    const content = buildUserContentWithAttachments("Analyze this", [textAttachment], true, false);

    expect(content).toEqual([
      { type: "text", text: "Analyze this" },
      { type: "text", text: '<file name="notes.txt">\nimportant context\n</file>' },
    ]);
  });

  it("returns the original prompt string when no attachments are provided", () => {
    const fullPrompt = "Command prompt\n\n## User Instructions\n\ndo X";

    expect(buildUserContentWithAttachments(fullPrompt, [], true, false)).toBe(fullPrompt);
  });

  it("injects the real zai vision tool hint for GLM models without image support", () => {
    const imageAttachment: ImageAttachment = {
      kind: "image",
      fileName: "screenshot.png",
      filePath: "/tmp/screenshot.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    };

    const content = buildUserContentWithAttachments(
      "What is this?",
      [imageAttachment],
      false,
      false,
      "glm",
    );

    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; text?: string }[];
    expect(parts[1]!.type).toBe("text");
    // GLM only: names the REAL MCP tool (the zai_vision server connects only
    // for the GLM provider) plus the tool_search unlock path for deferred MCP.
    expect(parts[1]!.text).toContain("mcp__zai_vision__analyze_image");
    expect(parts[1]!.text).toContain("tool_search");
    expect(parts[1]!.text).not.toContain("image_analysis tool");
    expect(parts[1]!.text).toMatch(/ggcoder-img-\d+\.png/);
  });

  it("keeps the non-GLM no-vision hint byte-identical (no zai tool named)", () => {
    const imageAttachment: ImageAttachment = {
      kind: "image",
      fileName: "screenshot.png",
      filePath: "/tmp/screenshot.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    };

    // DeepSeek also lacks native image support but has NO zai_vision server —
    // the zai hint must never leak to it.
    const content = buildUserContentWithAttachments(
      "What is this?",
      [imageAttachment],
      false,
      false,
      "deepseek",
    );

    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; text?: string }[];
    expect(parts[1]!.text).not.toContain("zai_vision");
    expect(parts[1]!.text).not.toContain("tool_search");
    expect(parts[1]!.text).toMatch(
      /^\[User attached an image saved at: .*ggcoder-img-\d+\.png — use the image_analysis tool to view and analyze it]$/,
    );
  });

  it("routes video via the read tool when the model supports video", () => {
    const videoAttachment: ImageAttachment = {
      kind: "video",
      fileName: "clip.mp4",
      filePath: "/tmp/clip.mp4",
      mediaType: "video/mp4",
      data: "AAAA",
    };

    const content = buildUserContentWithAttachments("Watch this", [videoAttachment], true, true);

    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; text?: string }[];
    expect(parts[0]).toEqual({ type: "text", text: "Watch this" });
    // Video-capable models are pointed at the file to read (not inlined), so
    // the read tool can auto-compress + deliver it in the provider's format.
    expect(parts[1]!.type).toBe("text");
    expect(parts[1]!.text).toContain("read tool");
    expect(parts[1]!.text).toContain("/tmp/clip.mp4");
  });

  it("states the attachment plainly (no analysis framing) when the model lacks video", () => {
    const videoAttachment: ImageAttachment = {
      kind: "video",
      fileName: "clip.mp4",
      filePath: "/tmp/clip.mp4",
      mediaType: "video/mp4",
      data: "AAAA",
    };

    const content = buildUserContentWithAttachments("Watch this", [videoAttachment], true, false);

    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; text?: string }[];
    expect(parts[0]).toEqual({ type: "text", text: "Watch this" });
    expect(parts[1]!.type).toBe("text");
    // No "watch/analyze this video" framing for a model that can't; just states
    // the file and offers ffmpeg as a fallback.
    expect(parts[1]!.text).toContain("cannot watch video");
    expect(parts[1]!.text).toContain("/tmp/clip.mp4");
    expect(parts[1]!.text).not.toContain("read tool");
  });

  it("handles a large path-only video (no inline base64) for video models", () => {
    const videoAttachment: ImageAttachment = {
      kind: "video",
      fileName: "big.mp4",
      filePath: "/tmp/big.mp4",
      mediaType: "video/mp4",
      data: "", // large clip: no inline base64, path-only
    };

    const content = buildUserContentWithAttachments("Watch this", [videoAttachment], true, true);

    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; text?: string }[];
    expect(parts[1]!.type).toBe("text");
    expect(parts[1]!.text).toContain("read tool");
    expect(parts[1]!.text).toContain("/tmp/big.mp4");
  });
});
