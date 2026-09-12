import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveModelMaxTokens } from "../core/model-registry.js";

describe("TUI request output-token caps", () => {
  it("uses Astra's output ceiling at startup", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(resolveModelMaxTokens("gpt-6-astra")).toBe(128_000);
    expect(source).toContain("maxTokens: resolveModelMaxTokens(currentModel, props.maxTokens)");
  });

  it("recomputes and clamps the cap when the live model changes", () => {
    expect([
      resolveModelMaxTokens("gpt-6-astra"),
      resolveModelMaxTokens("claude-haiku-4-5-20251001"),
    ]).toEqual([128_000, 64_000]);
    expect(resolveModelMaxTokens("gpt-6-astra", 100_000)).toBe(100_000);
    expect(resolveModelMaxTokens("claude-haiku-4-5-20251001", 100_000)).toBe(64_000);
  });

  it("keeps Astra's output ceiling independent of the context profile", () => {
    const profiles = ["stable", "experimental"] as const;

    expect(profiles.map(() => resolveModelMaxTokens("gpt-6-astra"))).toEqual([
      128_000,
      128_000,
    ]);
  });
});
