// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COMPACTION_LINES, CompactionNotice, describeCompaction } from "./CompactionNotice";

const fill = (line: string, from: number, to: number): string =>
  line.replace("{from}", String(from)).replace("{to}", String(to));

describe("COMPACTION_LINES", () => {
  it("has five distinct critter phrasings for every state", () => {
    for (const list of Object.values(COMPACTION_LINES)) {
      expect(list).toHaveLength(5);
      expect(new Set(list).size).toBe(5);
      for (const line of list) expect(line).toMatch(/^A critter /);
    }
  });

  it("puts both counts in every done line", () => {
    for (const line of COMPACTION_LINES.done) {
      expect(line).toContain("{from}");
      expect(line).toContain("{to}");
    }
  });
});

describe("describeCompaction", () => {
  it.each([
    ["running", "running", undefined, undefined, COMPACTION_LINES.running],
    ["done with counts", "done", 60, 14, COMPACTION_LINES.done.map((l) => fill(l, 60, 14))],
    ["done without counts", "done", undefined, undefined, COMPACTION_LINES.doneNoCounts],
  ] as const)("%s", (_name, status, from, to, expected) => {
    expect(expected).toContain(describeCompaction(status, "compaction-7", from, to));
  });

  it("keeps the same wording for the same notice", () => {
    expect(describeCompaction("done", "compaction-3", 60, 14)).toBe(
      describeCompaction("done", "compaction-3", 60, 14),
    );
  });

  it("varies the wording across notices, reaching all five phrasings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(describeCompaction("done", `compaction-${i}`, 60, 14));
    expect([...seen].sort()).toEqual(COMPACTION_LINES.done.map((l) => fill(l, 60, 14)).sort());
  });
});

describe("CompactionNotice", () => {
  const img = (container: HTMLElement): HTMLImageElement => {
    const el = container.querySelector<HTMLImageElement>(".subagents-critter-img");
    if (!el) throw new Error("critter missing");
    return el;
  };

  it("leads with a hopping critter instead of a dot while compacting", () => {
    const { container } = render(<CompactionNotice status="running" variantKey="compaction-1" />);
    expect(img(container).classList.contains("subagents-critter-working")).toBe(true);
    expect(container.textContent).not.toContain("\u23FA");
    expect(COMPACTION_LINES.running).toContain(container.textContent);
  });

  it("keeps the same critter from working to done, and stops hopping", () => {
    const { container, rerender } = render(
      <CompactionNotice status="running" variantKey="compaction-1" />,
    );
    const runningSprite = img(container).getAttribute("src");
    rerender(
      <CompactionNotice status="done" variantKey="compaction-1" originalCount={60} newCount={14} />,
    );
    expect(img(container).getAttribute("src")).toBe(runningSprite);
    expect(img(container).classList.contains("subagents-critter-working")).toBe(false);
    expect(container.textContent).toContain("60");
    expect(container.textContent).toContain("14");
  });
});
