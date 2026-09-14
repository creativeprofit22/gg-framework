import { describe, expect, it } from "vitest";
import { REDACTION_MARKER, environmentSecrets, redactText, redactValue } from "./redaction.js";

const CANARY = "canary-super-secret-123456";

describe("redactText", () => {
  it.each([
    ["Bearer abcdefghijklmnop", "Bearer [REDACTED]"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: [REDACTED]"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", REDACTION_MARKER],
    ["token=abcdefghijklmnop", "token=[REDACTED]"],
    ["Cookie: session=abcdefghijklmnop; theme=dark", "Cookie: [REDACTED]"],
    ["https://alice:password123@example.com/path", "https://[REDACTED]@example.com/path"],
    ["sk-ant-api03-abcdefghijklmnop", REDACTION_MARKER],
  ])("redacts %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("redacts private-key blocks", () => {
    const input = "before\n-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\nafter";
    expect(redactText(input)).toBe("before\n[REDACTED]\nafter");
  });

  it("redacts exact secrets and leaves short/common values alone", () => {
    expect(redactText(`secret=${CANARY} regular=hello`, { secrets: [CANARY, "hello"] })).toBe(
      "secret=[REDACTED] regular=hello",
    );
    expect(redactText("typescript tokenization monkey keyframe")).toBe(
      "typescript tokenization monkey keyframe",
    );
  });

  it("is idempotent", () => {
    const once = redactText(`Authorization: Bearer ${CANARY}`, { secrets: [CANARY] });
    expect(redactText(once, { secrets: [CANARY] })).toBe(once);
  });
});

describe("environmentSecrets", () => {
  it("collects only long values under sensitive names", () => {
    expect(
      environmentSecrets({
        OPENAI_API_KEY: CANARY,
        GITHUB_TOKEN: "github-token-1234",
        PASSWORD: "short",
        HOME: "/Users/example",
        EMPTY_SECRET: undefined,
      }),
    ).toEqual([CANARY, "github-token-1234"]);
  });
});

describe("redactValue", () => {
  it("immutably sanitizes nested values and sensitive keys", () => {
    const source = {
      ok: "ordinary",
      nested: { password: "tiny", note: `contains ${CANARY}` },
      count: 3,
      enabled: true,
    };
    const result = redactValue(source, { secrets: [CANARY] });

    expect(result).toEqual({
      ok: "ordinary",
      nested: { password: REDACTION_MARKER, note: "contains [REDACTED]" },
      count: 3,
      enabled: true,
    });
    expect(source.nested.password).toBe("tiny");
    expect(result).not.toBe(source);
    expect(result.nested).not.toBe(source.nested);
  });

  it("guards cycles, depth, and collection size", () => {
    const cyclic: Record<string, unknown> = { value: "safe" };
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ value: "safe", self: "[CIRCULAR]" });
    expect(redactValue({ a: { b: "value" } }, { maxDepth: 1 })).toEqual({ a: "[TRUNCATED]" });
    expect(redactValue([1, 2, 3], { maxEntries: 2 })).toEqual([1, 2, "[TRUNCATED]"]);
  });

  it("preserves binary/media payload data while cloning media containers", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const media = { type: "image", data: "base64-image-data", mimeType: "image/png" };
    const result = redactValue({ bytes, media });
    expect(result.bytes).toBe(bytes);
    expect(result.media).toEqual(media);
    expect(result.media).not.toBe(media);
  });
});
