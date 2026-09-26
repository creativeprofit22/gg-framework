import { describe, it, expect } from "vitest";
import { parseAutopilotVerdict } from "./autopilot-verdict.js";

describe("parseAutopilotVerdict", () => {
  it("parses ALL_CLEAR", () => {
    expect(parseAutopilotVerdict("ALL_CLEAR")).toEqual({ kind: "all_clear" });
  });

  it("preserves a structured corpus limitation separately from the verdict", () => {
    expect(
      parseAutopilotVerdict('{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified"}'),
    ).toEqual({ kind: "all_clear", evidenceLimitation: "corpus_unverified" });
  });

  it("accepts a fenced structured limitation", () => {
    expect(
      parseAutopilotVerdict(
        '```json\n{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified"}\n```',
      ),
    ).toEqual({ kind: "all_clear", evidenceLimitation: "corpus_unverified" });
  });

  it.each([
    '{"verdict":"ALL_CLEAR","evidenceLimitation":"verification_failed"}',
    '{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified","checks":"failed"}',
    '{"verdict":"ALL_CLEAR","warning":"verification remains unproven"}',
    '{"verdict":"PROMPT","evidenceLimitation":"corpus_unverified"}',
    '{"verdict":"ALL_CLEAR",\nALL_CLEAR',
    "[\nALL_CLEAR\n]",
    '```json\n{"verdict":"ALL_CLEAR","checks":"failed"}\nALL_CLEAR',
    '[{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified"}]',
    JSON.stringify({ verdict: "ALL_CLEAR", evidenceLimitation: "x".repeat(2048) }),
  ])("fails closed on unsupported structured verdict %s", (reply) => {
    expect(parseAutopilotVerdict(reply).kind).toBe("human");
  });

  it("parses fuzzy ALL CLEAR (space + lowercase)", () => {
    expect(parseAutopilotVerdict("all clear")).toEqual({ kind: "all_clear" });
    expect(parseAutopilotVerdict("All Clear\nlooks good")).toEqual({ kind: "all_clear" });
  });

  it("parses IGNORE", () => {
    expect(parseAutopilotVerdict("IGNORE")).toEqual({ kind: "ignore" });
  });

  it("parses fuzzy IGNORE (lowercase, trailing colon, extra text)", () => {
    expect(parseAutopilotVerdict("ignore")).toEqual({ kind: "ignore" });
    expect(parseAutopilotVerdict("Ignore:\nnothing to review")).toEqual({ kind: "ignore" });
  });

  it("parses SKIP as an alias for IGNORE", () => {
    expect(parseAutopilotVerdict("SKIP")).toEqual({ kind: "ignore" });
  });

  it("parses PROMPT with a multi-line body", () => {
    const reply = "PROMPT\nAdd a test for the login flow.\nRun it and confirm it passes.";
    expect(parseAutopilotVerdict(reply)).toEqual({
      kind: "prompt",
      body: "Add a test for the login flow.\nRun it and confirm it passes.",
    });
  });

  it("tolerates a PROMPT: keyword with a colon", () => {
    expect(parseAutopilotVerdict("PROMPT:\nFix the off-by-one in pagination.")).toEqual({
      kind: "prompt",
      body: "Fix the off-by-one in pagination.",
    });
  });

  it("parses inline PROMPT body on the keyword line", () => {
    expect(parseAutopilotVerdict("PROMPT: Fix the failing build.")).toEqual({
      kind: "prompt",
      body: "Fix the failing build.",
    });
  });

  it("strips a ```prompt fence Ken wrapped the body in", () => {
    const reply = "PROMPT\n```prompt\nWire the button to the handler.\n```";
    expect(parseAutopilotVerdict(reply)).toEqual({
      kind: "prompt",
      body: "Wire the button to the handler.",
    });
  });

  it("strips a plain ``` fence", () => {
    const reply = "PROMPT\n```\nAdd error handling to the fetch call.\n```";
    expect(parseAutopilotVerdict(reply)).toEqual({
      kind: "prompt",
      body: "Add error handling to the fetch call.",
    });
  });

  it("downgrades an empty PROMPT to human", () => {
    const v = parseAutopilotVerdict("PROMPT\n\n");
    expect(v.kind).toBe("human");
  });

  it("parses HUMAN with a reason", () => {
    expect(parseAutopilotVerdict("HUMAN\nThe requirement is ambiguous.")).toEqual({
      kind: "human",
      reason: "The requirement is ambiguous.",
    });
  });

  it("parses inline HUMAN reason on the keyword line", () => {
    expect(parseAutopilotVerdict("HUMAN: need a design decision")).toEqual({
      kind: "human",
      reason: "need a design decision",
    });
  });

  it("gives HUMAN a default reason when none provided", () => {
    const v = parseAutopilotVerdict("HUMAN");
    expect(v.kind).toBe("human");
    if (v.kind === "human") expect(v.reason.length).toBeGreaterThan(0);
  });

  it("falls back to human on an unrecognized reply", () => {
    const v = parseAutopilotVerdict("looks great, ship it!");
    expect(v.kind).toBe("human");
    if (v.kind === "human") expect(v.reason).toContain("looks great");
  });

  it("falls back to human on an empty reply", () => {
    expect(parseAutopilotVerdict("").kind).toBe("human");
    expect(parseAutopilotVerdict("   \n  ").kind).toBe("human");
  });

  it("skips leading blank lines before the keyword", () => {
    expect(parseAutopilotVerdict("\n\nALL_CLEAR")).toEqual({ kind: "all_clear" });
  });

  it("recovers ALL_CLEAR when Ken adds commentary before a trailing bare keyword line", () => {
    const reply =
      "The label is now a plain non-clickable <span>, model name is the separate " +
      "clickable button. Matches the request exactly. Typecheck passed.\nALL_CLEAR";
    expect(parseAutopilotVerdict(reply)).toEqual({ kind: "all_clear" });
  });

  it("recovers IGNORE from a trailing bare keyword line after commentary", () => {
    const reply = "Just a formatting fix, nothing to review here.\nIGNORE";
    expect(parseAutopilotVerdict(reply)).toEqual({ kind: "ignore" });
  });

  it("recovers a buried PROMPT with the body on following lines", () => {
    const reply = "Some commentary about the change.\nPROMPT\nFix the bug.";
    expect(parseAutopilotVerdict(reply)).toEqual({ kind: "prompt", body: "Fix the bug." });
  });

  it("recovers a buried PROMPT with an inline body (the real drift shape)", () => {
    // The exact drift that stalled a live autopilot cycle: reasoning prose
    // first, then `PROMPT <body>` on one line — used to parse as a HUMAN stop
    // and dump the whole reply into the chat as a Ken bubble.
    const reply =
      "The diagnosis is solid and confirmed on disk. The fix is mechanically " +
      "implied by the original ask. Safe to proceed without new user input.\n" +
      "PROMPT Apply the fix: guard AgentSession.compact() on this.opts.transient.";
    const v = parseAutopilotVerdict(reply);
    expect(v.kind).toBe("prompt");
    if (v.kind === "prompt") {
      expect(v.body).toBe("Apply the fix: guard AgentSession.compact() on this.opts.transient.");
    }
  });

  it("never matches lowercase or mid-line 'prompt' prose as a buried PROMPT", () => {
    // Buried recovery is uppercase + line-start only — casual prose mentioning
    // "prompt" after an unrecognized first line must stay a HUMAN stop.
    expect(
      parseAutopilotVerdict("Waiting on input.\nprompt the user for their API key first.").kind,
    ).toBe("human");
    expect(
      parseAutopilotVerdict("Unclear ask.\nWe should write a prompt for GG Coder here.").kind,
    ).toBe("human");
  });

  it("prefers a buried HUMAN over a buried PROMPT — stops beat actions on ties", () => {
    const reply = "Recap first.\nPROMPT Fix the thing.\nHUMAN\nActually the user must decide.";
    const v = parseAutopilotVerdict(reply);
    expect(v.kind).toBe("human");
    if (v.kind === "human") expect(v.reason).toBe("Actually the user must decide.");
  });

  it("downgrades a buried bare PROMPT with no body to human", () => {
    const v = parseAutopilotVerdict("Recap of what happened.\nPROMPT");
    expect(v.kind).toBe("human");
  });

  it("recovers a buried HUMAN, dropping the leading reasoning prose", () => {
    // Ken drifted: he wrote his whole recap first, THEN the verdict. Recover the
    // reason after the keyword and drop the prose — HUMAN stops either way.
    const reply =
      "The screenshot shows a clean squared inward spiral that matches the " +
      "reference. Tests green. GG Coder asked whether to dress it up with art — " +
      "that's a taste/product call the user should own.\nHUMAN\nStructural spiral " +
      "is done; dressing it up with art is a taste call only you can make.";
    const v = parseAutopilotVerdict(reply);
    expect(v.kind).toBe("human");
    if (v.kind === "human") {
      expect(v.reason).toBe(
        "Structural spiral is done; dressing it up with art is a taste call only you can make.",
      );
      expect(v.reason).not.toContain("The screenshot shows");
    }
  });

  it("gives a buried bare HUMAN with no trailing reason the default reason", () => {
    const v = parseAutopilotVerdict("Long recap of the work with no verdict payload.\nHUMAN");
    expect(v.kind).toBe("human");
    if (v.kind === "human") expect(v.reason.length).toBeGreaterThan(0);
  });
});
