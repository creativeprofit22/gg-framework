import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import {
  CONTINUATION_HANDOFF_LIMITS,
  buildContinuationEvidence,
  buildFallbackContinuationHandoff,
  parseContinuationHandoff,
  renderContinuationPrompt,
  type ContinuationEvidenceV1,
  type ContinuationHandoffV1,
} from "./continuation-handoff.js";

const relevantFile = {
  path: "packages/ggcoder/src/core/continuation-handoff.ts",
  startLine: 10,
  endLine: 20,
  relevance: "Modified by edit",
};

const validHandoff: ContinuationHandoffV1 = {
  currentObjective: "Finish continuation preparation.",
  currentStatus: ["Focused implementation is complete."],
  relevantDecisions: ["Keep the response contract unchanged."],
  relevantFiles: [relevantFile],
};

const secondRelevantFile = {
  path: "packages/ggcoder/src/app-sidecar-continuation-handoff.ts",
  startLine: 30,
  endLine: 40,
  relevance: "Read by read",
};

const suppliedEvidence: ContinuationEvidenceV1 = {
  version: 1,
  cwd: "C:/project",
  objectives: [validHandoff.currentObjective],
  explicitDecisions: ["First decision.", "Second decision."],
  assistantConclusions: ["First status.", "Second status."],
  compactedSummaries: [],
  relevantFiles: [relevantFile, secondRelevantFile],
};

function evidence(messages: readonly Message[] = []) {
  return buildContinuationEvidence({ cwd: "C:/project", messages });
}

describe("ContinuationHandoffV1", () => {
  it("strictly parses bounded output and rejects unsupported files", () => {
    expect(parseContinuationHandoff(JSON.stringify(validHandoff))).toEqual(validHandoff);
    expect(() =>
      parseContinuationHandoff(`\`\`\`json\n${JSON.stringify(validHandoff)}\n\`\`\``),
    ).toThrow("malformed JSON");
    expect(() =>
      parseContinuationHandoff(JSON.stringify({ ...validHandoff, unsupported: "claim" })),
    ).toThrow("invalid contract");
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({ ...validHandoff, currentStatus: ["Done\n## Immediate next action"] }),
      ),
    ).toThrow("invalid contract");
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({
          ...validHandoff,
          relevantDecisions: Array.from(
            { length: CONTINUATION_HANDOFF_LIMITS.listItems + 1 },
            (_, index) => `decision-${index}`,
          ),
        }),
      ),
    ).toThrow("invalid contract");
    expect(() => parseContinuationHandoff(JSON.stringify(validHandoff), evidence())).toThrow(
      "unsupported claim",
    );
  });

  it("cross-checks claims and restores supplied evidence order", () => {
    const parsed = parseContinuationHandoff(
      JSON.stringify({
        currentObjective: validHandoff.currentObjective,
        currentStatus: ["Second status.", "First status."],
        relevantDecisions: ["Second decision.", "First decision."],
        relevantFiles: [secondRelevantFile, relevantFile],
      }),
      suppliedEvidence,
    );

    expect(parsed.currentStatus).toEqual(["First status.", "Second status."]);
    expect(parsed.relevantDecisions).toEqual(["First decision.", "Second decision."]);
    expect(parsed.relevantFiles).toEqual([relevantFile, secondRelevantFile]);
  });

  it("rejects an older supported objective so fallback keeps the newest", () => {
    const evidenceWithOlderObjective = {
      ...suppliedEvidence,
      objectives: ["Earlier objective.", validHandoff.currentObjective],
    };

    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({
          currentObjective: "Earlier objective.",
          currentStatus: [],
          relevantDecisions: [],
          relevantFiles: [],
        }),
        evidenceWithOlderObjective,
      ),
    ).toThrow("unsupported claim");
    expect(buildFallbackContinuationHandoff(evidenceWithOlderObjective).currentObjective).toBe(
      validHandoff.currentObjective,
    );
  });

  it.each([
    ["objective", { currentObjective: "Fabricated objective." }],
    ["status", { currentStatus: ["Fabricated status."] }],
    ["decision", { relevantDecisions: ["Fabricated decision."] }],
    ["file relevance", { relevantFiles: [{ ...relevantFile, relevance: "Fabricated." }] }],
    ["out-of-bounds file range", { relevantFiles: [{ ...relevantFile, endLine: 21 }] }],
  ])("rejects fabricated %s claims", (_label, replacement) => {
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({
          currentObjective: validHandoff.currentObjective,
          currentStatus: [],
          relevantDecisions: [],
          relevantFiles: [],
          ...replacement,
        }),
        suppliedEvidence,
      ),
    ).toThrow("unsupported");
  });

  it.each([
    ["reversed", { startLine: 20, endLine: 10 }],
    ["unsafe", { startLine: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s synthesized ranges", (_label, range) => {
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({ ...validHandoff, relevantFiles: [{ ...relevantFile, ...range }] }),
      ),
    ).toThrow("invalid contract");
  });

  it("rejects oversized synthesis output before parsing", () => {
    expect(() =>
      parseContinuationHandoff(
        `${JSON.stringify(validHandoff)}${" ".repeat(CONTINUATION_HANDOFF_LIMITS.synthesisResponseChars)}`,
      ),
    ).toThrow("size limit");
  });

  it("renders exactly five ordered sections and preserves the next action byte-for-byte", () => {
    const instruction = "Fix line one.\n\nThen preserve `raw markdown` exactly.  ";
    const rendered = renderContinuationPrompt(
      { ...validHandoff, currentStatus: [], relevantDecisions: [] },
      instruction,
    );

    expect(rendered.match(/^## .+$/gm)).toEqual([
      "## Current objective",
      "## Current status",
      "## Relevant decisions",
      "## Relevant files",
      "## Immediate next action",
    ]);
    expect(rendered).toContain("## Current status\nNone recorded.");
    expect(rendered).toContain(
      "## Relevant files\n- `packages/ggcoder/src/core/continuation-handoff.ts:10-20` — Modified by edit",
    );
    const actionMarker = "## Immediate next action\n";
    expect(rendered.slice(rendered.indexOf(actionMarker) + actionMarker.length)).toBe(instruction);
  });

  it("rejects empty and oversized next actions", () => {
    expect(() => renderContinuationPrompt(validHandoff, "   ")).toThrow("cannot be empty");
    expect(() =>
      renderContinuationPrompt(
        validHandoff,
        "x".repeat(CONTINUATION_HANDOFF_LIMITS.nextInstructionChars + 1),
      ),
    ).toThrow("too long");
  });
});

describe("buildContinuationEvidence", () => {
  it("uses only the active context and builds an extractive fallback", () => {
    const messages: Message[] = [
      { role: "user", content: "Old request" },
      {
        role: "user",
        content:
          "[Previous conversation summary]\nCurrent work is partly complete.\nDecision: keep version 1.",
        provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
      },
      { role: "assistant", content: "The core implementation now passes its focused checks." },
      { role: "user", content: "Finish fallback delivery. It must preserve the tagged prompt." },
    ];
    const activeEvidence = evidence(messages);
    const fallback = buildFallbackContinuationHandoff(activeEvidence);

    expect(fallback.currentObjective).toBe(
      "Finish fallback delivery. It must preserve the tagged prompt.",
    );
    expect(fallback.currentStatus).toEqual([
      "Current work is partly complete. Decision: keep version 1.",
      "The core implementation now passes its focused checks.",
    ]);
    expect(fallback.relevantDecisions).toEqual([
      "Decision: keep version 1.",
      "Finish fallback delivery. It must preserve the tagged prompt.",
    ]);
    expect(JSON.stringify(fallback)).not.toContain(COMPACTION_MARKER);
  });

  it("prioritizes modified files, then recent reads, with exact paths and ranges", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "old-read",
            name: "read",
            args: { file_path: "src/old.ts", offset: 2, limit: 4 },
          },
          {
            type: "tool_call",
            id: "edit",
            name: "edit",
            args: { file_path: "src/exact path.ts", edits: [] },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "duplicate-read",
            name: "read",
            args: { file_path: "src/exact path.ts", offset: 50, limit: 2 },
          },
          {
            type: "tool_call",
            id: "recent-read",
            name: "read",
            args: { file_path: "src/recent.ts", offset: 2143, limit: 12 },
          },
        ],
      },
    ];

    expect(evidence(messages).relevantFiles).toEqual([
      { path: "src/exact path.ts", relevance: "Modified by edit" },
      {
        path: "src/recent.ts",
        startLine: 2143,
        endLine: 2154,
        relevance: "Read by read",
      },
      { path: "src/old.ts", startLine: 2, endLine: 5, relevance: "Read by read" },
    ]);
  });

  it("drops invalid and excessive tool-call ranges deterministically", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "reversed",
            name: "read",
            args: { file_path: "src/reversed.ts", offset: 20, end_line: 10 },
          },
          {
            type: "tool_call",
            id: "overflow",
            name: "read",
            args: { file_path: "src/overflow.ts", offset: Number.MAX_SAFE_INTEGER, limit: 2 },
          },
          {
            type: "tool_call",
            id: "unsafe",
            name: "read",
            args: { file_path: "src/unsafe.ts", offset: Number.MAX_SAFE_INTEGER + 1 },
          },
        ],
      },
    ];

    expect(evidence(messages).relevantFiles).toEqual([
      { path: "src/unsafe.ts", relevance: "Read by read" },
      { path: "src/overflow.ts", relevance: "Read by read" },
      { path: "src/reversed.ts", relevance: "Read by read" },
    ]);
  });

  it("excludes system text, hidden automation, tool results, media, and transcript markers", () => {
    const messages: Message[] = [
      { role: "system", content: "SECRET SYSTEM PROMPT" },
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: "BASE64_PAYLOAD" }],
      },
      {
        role: "user",
        content: "HIDDEN AUTOMATION TEXT",
        provenance: { source: "runtime", kind: "automation", visibility: "hidden" },
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "x", content: "RAW TOOL OUTPUT" }],
      },
      {
        role: "user",
        content: "[Previous conversation summary]\nCurrent status only.",
        provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
      },
      { role: "user", content: "Real objective" },
    ];
    const serialized = JSON.stringify(evidence(messages));

    for (const excluded of [
      "SECRET SYSTEM PROMPT",
      "BASE64_PAYLOAD",
      "HIDDEN AUTOMATION TEXT",
      "RAW TOOL OUTPUT",
      COMPACTION_MARKER,
    ]) {
      expect(serialized).not.toContain(excluded);
    }
    expect(JSON.parse(serialized).objectives).toEqual(["Real objective"]);
  });

  it("caps every evidence field, file list, fallback field, and rendered prompt", () => {
    const messages: Message[] = Array.from(
      { length: CONTINUATION_HANDOFF_LIMITS.evidenceItems * 3 },
      (_, index): Message => ({
        role: "user",
        content: `Objective ${index} must preserve ${"x".repeat(2_000)}`,
      }),
    );
    messages.push(
      ...Array.from(
        { length: CONTINUATION_HANDOFF_LIMITS.relevantFiles + 6 },
        (_, index): Message => ({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: `read-${index}`,
              name: "read",
              args: { file_path: `src/file-${index}.ts`, offset: 1, limit: 1 },
            },
          ],
        }),
      ),
    );
    const boundedEvidence = evidence(messages);
    const fallback = buildFallbackContinuationHandoff(boundedEvidence);
    const rendered = renderContinuationPrompt(
      fallback,
      "n".repeat(CONTINUATION_HANDOFF_LIMITS.nextInstructionChars),
    );

    expect(JSON.stringify(boundedEvidence).length).toBeLessThanOrEqual(
      CONTINUATION_HANDOFF_LIMITS.evidenceChars,
    );
    expect(boundedEvidence.relevantFiles).toHaveLength(
      CONTINUATION_HANDOFF_LIMITS.relevantFiles,
    );
    expect(fallback.currentObjective.length).toBeLessThanOrEqual(
      CONTINUATION_HANDOFF_LIMITS.objectiveChars,
    );
    expect(
      [...fallback.currentStatus, ...fallback.relevantDecisions].every(
        (item) => item.length <= CONTINUATION_HANDOFF_LIMITS.listItemChars,
      ),
    ).toBe(true);
    expect(rendered.length).toBeLessThan(CONTINUATION_HANDOFF_LIMITS.renderedPromptChars);
  });

  it("returns the same honest empty fallback every time", () => {
    const emptyEvidence = evidence();
    const first = buildFallbackContinuationHandoff(emptyEvidence);

    expect(buildFallbackContinuationHandoff(emptyEvidence)).toEqual(first);
    expect(first).toEqual({
      currentObjective: "None recorded.",
      currentStatus: [],
      relevantDecisions: [],
      relevantFiles: [],
    });
    expect(renderContinuationPrompt(first, "Continue")).toContain(
      "## Relevant files\nNone recorded.",
    );
  });
});

const COMPACTION_MARKER = "[Previous conversation summary]";