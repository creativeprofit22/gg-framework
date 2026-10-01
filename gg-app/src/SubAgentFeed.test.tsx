// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CRITTERS, renderCritterFrame } from "./critter-sprites";
import {
  CRITTER_LINES,
  formatSubAgentTokens,
  SubAgentFeed,
  summarizeCritters,
  type SubAgentLine,
} from "./SubAgentFeed";

describe("formatSubAgentTokens", () => {
  it("adds Anthropic cache writes to fresh input for provider-neutral usage", () => {
    expect(
      formatSubAgentTokens({ input: 2, output: 500, cacheRead: 80_000, cacheWrite: 12_000 }),
    ).toBe("↑ 12.0k · ↻ 80k cached · ↓ 500");
  });

  it("keeps OpenAI non-cached input unchanged", () => {
    expect(formatSubAgentTokens({ input: 50_000, output: 800, cacheRead: 65_000 })).toBe(
      "↑ 50k · ↻ 65k cached · ↓ 800",
    );
  });
});

let nextCall = 0;
function agent(status: SubAgentLine["status"], toolCallId = `call-${nextCall++}`): SubAgentLine {
  return {
    toolCallId,
    agentName: "researcher",
    status,
    activities: [],
    toolUseCount: 3,
    tokenUsage: { input: 0, output: 0 },
    durationMs: 9000,
  };
}

/** Every phrasing a line could take, with `{n}` filled in. */
function variants(lines: { one: readonly string[]; many: readonly string[] }, n: number): string[] {
  return (n === 1 ? lines.one : lines.many).map((line) => line.replace("{n}", String(n)));
}

describe("CRITTER_LINES", () => {
  it("has five distinct phrasings for every outcome, singular and plural", () => {
    for (const lines of Object.values(CRITTER_LINES)) {
      for (const list of [lines.one, lines.many]) {
        expect(list).toHaveLength(5);
        expect(new Set(list).size).toBe(5);
      }
    }
  });

  it("keeps lines simple: no agent names, durations or follow-up notes", () => {
    const all = Object.values(CRITTER_LINES).flatMap((lines) => [...lines.one, ...lines.many]);
    for (const line of all) expect(line).not.toMatch(/researcher|\d+s\b|·|follow-up/);
  });
});

describe("summarizeCritters", () => {
  it.each([
    ["one running", [agent("running")], false, CRITTER_LINES.launched, 1, "working"],
    [
      "two starting",
      [agent("starting"), agent("running")],
      false,
      CRITTER_LINES.launched,
      2,
      "working",
    ],
    [
      "still running",
      [agent("running"), agent("done")],
      false,
      CRITTER_LINES.launched,
      2,
      "working",
    ],
    ["one done", [agent("done")], false, CRITTER_LINES.succeeded, 1, "done"],
    ["done and idle", [agent("done"), agent("idle")], false, CRITTER_LINES.succeeded, 2, "done"],
    ["one failed", [agent("error")], false, CRITTER_LINES.failed, 1, "failed"],
    [
      "all failed",
      [agent("error"), agent("interrupted")],
      false,
      CRITTER_LINES.failed,
      2,
      "failed",
    ],
    ["some failed", [agent("idle"), agent("error")], false, CRITTER_LINES.someFailed, 1, "failed"],
    [
      "two of three failed",
      [agent("done"), agent("error"), agent("error")],
      false,
      CRITTER_LINES.someFailed,
      2,
      "failed",
    ],
    ["stopped", [agent("running"), agent("running")], true, CRITTER_LINES.calledBack, 2, "failed"],
  ] as const)("%s", (_name, agents, aborted, lines, n, tone) => {
    const summary = summarizeCritters(agents, aborted);
    expect(summary.tone).toBe(tone);
    expect(variants(lines, n)).toContain(summary.text);
  });

  it("keeps the same wording for the same group on every render", () => {
    const group = [agent("done", "call-stable"), agent("done")];
    expect(summarizeCritters(group).text).toBe(summarizeCritters([...group]).text);
  });

  it("varies the wording across groups, reaching all five phrasings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(summarizeCritters([agent("error", `run-${i}`)]).text);
    expect([...seen].sort()).toEqual(variants(CRITTER_LINES.failed, 1).sort());
  });
});

describe("SubAgentFeed", () => {
  const img = (container: HTMLElement): HTMLImageElement => {
    const el = container.querySelector<HTMLImageElement>(".subagents-critter-img");
    if (!el) throw new Error("critter missing");
    return el;
  };
  const beeSprite = (): string => {
    const bee = CRITTERS.find((c) => c.id === "bee");
    if (!bee) throw new Error("bee missing");
    return renderCritterFrame(bee, 0);
  };

  it("leads the line with the agent's own critter instead of a dot", () => {
    const bee = { ...agent("running"), agentName: "bee" };
    const { container } = render(<SubAgentFeed agents={[bee]} />);
    expect(img(container).getAttribute("src")).toBe(beeSprite());
    expect(img(container).classList.contains("subagents-critter-working")).toBe(true);
    expect(container.textContent).not.toContain("\u23FA");
  });

  it("tips the critter over when the agents failed", () => {
    const { container } = render(<SubAgentFeed agents={[agent("error")]} />);
    expect(img(container).classList.contains("subagents-critter-failed")).toBe(true);
  });

  it("renders nothing for an empty group", () => {
    const { container } = render(<SubAgentFeed agents={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
