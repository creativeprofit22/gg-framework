import { describe, expect, it, vi } from "vitest";
import { ENHANCE_PROMPT_MAX_CHARS, runEnhancePromptRequest } from "./app-sidecar-enhance.js";

describe("app sidecar prompt enhancement validation", () => {
  it.each([
    [null, "text must be a string"],
    [{}, "text must be a string"],
    [{ text: 42 }, "text must be a string"],
    [{ text: "   " }, "empty prompt"],
    [{ text: "x".repeat(ENHANCE_PROMPT_MAX_CHARS + 1) }, "prompt exceeds 12000 characters"],
    [{ text: `${"😀".repeat(6_000)}x` }, "prompt exceeds 12000 characters"],
  ])("rejects invalid input before model invocation: %#", async (body, error) => {
    const enhance = vi.fn(async () => ({ enhanced: "unused", segments: [] }));
    await expect(runEnhancePromptRequest(body, enhance)).resolves.toEqual({
      status: 400,
      body: { error },
    });
    expect(enhance).not.toHaveBeenCalled();
  });

  it.each(["x".repeat(12_000), "😀".repeat(6_000)])("accepts a non-empty prompt at the UTF-16 limit: %#", async (text) => {
    expect(text.length).toBe(ENHANCE_PROMPT_MAX_CHARS);
    const result = { enhanced: "done", segments: [] };
    const enhance = vi.fn(async () => result);
    await expect(runEnhancePromptRequest({ text }, enhance)).resolves.toEqual({
      status: 200,
      body: result,
    });
    expect(enhance).toHaveBeenCalledWith(text);
  });
});
