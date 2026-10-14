import { describe, expect, it } from "vitest";
import { resolveThinkingRequest } from "./thinking-request.js";

// Claude Sonnet 5.5 cycles low → medium → high → xhigh → off.
const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-5-5";

describe("resolveThinkingRequest", () => {
  it("cycles to the next level when the body is empty", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "medium", "")).toEqual({
      ok: true,
      level: "high",
    });
  });

  it("jumps straight to a requested level", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "low", '{"level":"xhigh"}')).toEqual({
      ok: true,
      level: "xhigh",
    });
  });

  it("turns thinking off for a null level", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "high", '{"level":null}')).toEqual({
      ok: true,
      level: undefined,
    });
  });

  it("refuses a level the model doesn't support", () => {
    const result = resolveThinkingRequest(PROVIDER, "claude-sonnet-5", "low", '{"level":"xhigh"}');
    expect(result.ok).toBe(false);
  });

  it("refuses malformed JSON", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "low", "{nope").ok).toBe(false);
  });
});
