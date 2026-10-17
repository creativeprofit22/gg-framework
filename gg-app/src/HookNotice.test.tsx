// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeHook, HOOK_KINDS, HOOK_LINES, HookNotice, isHookKind } from "./HookNotice";
import { theme } from "./theme";

describe("HOOK_LINES", () => {
  it("has five distinct critter phrasings for every hook and reason", () => {
    for (const list of Object.values(HOOK_LINES)) {
      expect(list).toHaveLength(5);
      expect(new Set(list).size).toBe(5);
      for (const line of list) expect(line).toMatch(/^A critter is .+…$/);
    }
  });

  it("never falls back to the old 'Hook engaged' copy", () => {
    for (const line of Object.values(HOOK_LINES).flat()) expect(line).not.toMatch(/hook/i);
  });
});

describe("isHookKind", () => {
  it.each([...HOOK_KINDS])("accepts %s", (kind) => expect(isHookKind(kind)).toBe(true));
  it.each(["", "Ideal", "unknown", "toString", "__proto__"])("rejects %j", (kind) =>
    expect(isHookKind(kind)).toBe(false),
  );
});

describe("describeHook", () => {
  it.each([
    ["ideal", undefined, HOOK_LINES.ideal],
    ["verification", undefined, HOOK_LINES.verification],
    ["verification", "recheck", HOOK_LINES.recheck],
    ["verification", "check_review", HOOK_LINES.check_review],
    ["loop_break", undefined, HOOK_LINES.loop_break],
    ["regrounding", undefined, HOOK_LINES.regrounding],
  ] as const)("%s (%s) uses its own lines", (hook, reason, lines) => {
    expect(lines).toContain(describeHook(hook, "hook-4", reason));
  });

  it("keeps the same wording for the same row", () => {
    expect(describeHook("ideal", "hook-9")).toBe(describeHook("ideal", "hook-9"));
  });

  it("varies the wording across rows, reaching all five phrasings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(describeHook("loop_break", `hook-${i}`));
    expect([...seen].sort()).toEqual([...HOOK_LINES.loop_break].sort());
  });
});

describe("HookNotice", () => {
  it("renders a hopping critter with shimmering pink text instead of a dot", () => {
    const { container } = render(<HookNotice hook="verification" variantKey="hook-1" />);
    const img = container.querySelector(".subagents-critter-img");
    const text = container.querySelector<HTMLElement>(".subagents-compact-text");
    expect(img?.classList.contains("subagents-critter-working")).toBe(true);
    expect(text?.style.color).toBe(theme.critter);
    expect(container.querySelector(".shimmer-text")).not.toBeNull();
    expect(container.textContent).not.toContain("\u23FA");
    expect(HOOK_LINES.verification).toContain(container.textContent);
  });
});
