import { describe, expect, it } from "vitest";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";

describe("normalizePromptCacheKey", () => {
  it("leaves valid cache keys unchanged", () => {
    expect(normalizePromptCacheKey("ggcoder:short-session-id")).toBe("ggcoder:short-session-id");
  });

  it("clamps long cache keys to OpenAI's 64 character limit", () => {
    const longKey = `ggcoder-worker:linktree-harmony:${"a".repeat(36)}`;
    const normalized = normalizePromptCacheKey(longKey);

    expect(longKey.length).toBeGreaterThan(64);
    expect(normalized.length).toBeLessThanOrEqual(64);
    expect(normalized).toMatch(/^ggcoder-worker:linktree-harmony:.*:[0-9a-f]{8}$/);
  });

  it("keeps different long keys distinct", () => {
    const first = normalizePromptCacheKey(`ggcoder-worker:linktree-harmony:${"a".repeat(36)}`);
    const second = normalizePromptCacheKey(`ggcoder-worker:linktree-harmony:${"b".repeat(36)}`);

    expect(first).not.toBe(second);
  });
});
