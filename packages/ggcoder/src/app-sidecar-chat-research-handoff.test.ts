import { describe, expect, it } from "vitest";
import {
  buildChatResearchContinuationPrompt,
  CHAT_RESEARCH_COMMAND,
  normalizeChatResearchFocus,
  parseChatResearchCommand,
} from "./app-sidecar-chat-research-handoff.js";

describe("chat Research command", () => {
  it("publishes isolated command metadata without aliases", () => {
    expect(CHAT_RESEARCH_COMMAND).toEqual({
      name: "research",
      aliases: [],
      description: "Research this conversation and draft net-new Roadmap phases",
      usage: "/research [optional focus]",
      source: "built-in",
    });
  });

  it("recognizes only the exact case-sensitive command token", () => {
    expect(parseChatResearchCommand("/research")).toEqual({
      focus: null,
      displayText: "/research",
    });
    expect(parseChatResearchCommand("  /research  ")).toEqual({
      focus: null,
      displayText: "/research",
    });

    for (const input of [
      "research",
      "/Research",
      "/RESEARCH",
      "/r",
      "/researcher",
      "/research-now",
      "/research/roadmap",
      "/research: roadmap",
      "/researching roadmap",
    ]) {
      expect(parseChatResearchCommand(input), input).toBeNull();
    }
  });

  it("normalizes optional focus whitespace for execution and display", () => {
    expect(normalizeChatResearchFocus(" \t roadmap   review\n references  ")).toBe(
      "roadmap review references",
    );
    expect(normalizeChatResearchFocus(" \n\t ")).toBeNull();
    expect(parseChatResearchCommand("/research\t roadmap   review\n references ")).toEqual({
      focus: "roadmap review references",
      displayText: "/research roadmap review references",
    });
    expect(parseChatResearchCommand("/research\n\t")).toEqual({
      focus: null,
      displayText: "/research",
    });
  });
});

describe("buildChatResearchContinuationPrompt", () => {
  it("carries normalized focus into a hidden same-conversation continuation", () => {
    const prompt = buildChatResearchContinuationPrompt("  approval   UX\n and citations ");

    expect(prompt).toContain("Continue this same chat as Research");
    expect(prompt).toContain("entire preceding Brainstorm conversation");
    expect(prompt).toContain("<research_focus>approval UX and citations</research_focus>");
    expect(prompt).not.toContain("approval   UX");
  });

  it("encodes the inspect, dedupe, reference, draft, approval, and stop contract", () => {
    const prompt = buildChatResearchContinuationPrompt();
    const inspectIndex = prompt.indexOf("`roadmap_inspect`");
    const draftIndex = prompt.indexOf("`roadmap_phase_draft`");

    expect(prompt).toContain("Gather and verify current authoritative evidence");
    expect(prompt).toContain("Ask one focused clarification");
    expect(prompt).toContain("genuinely material product decision");
    expect(inspectIndex).toBeGreaterThan(-1);
    expect(draftIndex).toBeGreaterThan(inspectIndex);
    expect(prompt).toContain("remove work already covered");
    expect(prompt).toContain("If nothing net-new remains");
    expect(prompt).toContain("canonical references attached to the relevant proposed phases");
    expect(prompt).toContain("flat peer phases");
    expect(prompt).toContain("stop pending explicit user approval");
    expect(prompt).toContain("Do not approve it");
    expect(prompt).toContain("implement anything");
    expect(prompt).toContain("open a coding session");
  });
});
