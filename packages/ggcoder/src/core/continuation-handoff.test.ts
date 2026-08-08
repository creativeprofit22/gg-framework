import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import {
  CONTINUATION_HANDOFF_LIMITS,
  buildContinuationEvidence,
  parseContinuationHandoff,
  renderContinuationPrompt,
  type ContinuationHandoffV1,
} from "./continuation-handoff.js";

const validHandoff: ContinuationHandoffV1 = {
  objective: "Carry the implementation into a fresh session.",
  verifiedWork: ["Focused tests passed."],
  decisions: ["Prepare before resetting."],
  constraints: ["Continue here must remain unchanged."],
  repositoryCoordinates: [
    { path: "src/AgentPane.tsx", startLine: 10, endLine: 20, relevance: "Fresh-session flow" },
  ],
  artifactPaths: [{ path: ".gg/plans/handoff.md", relevance: "Approved plan" }],
  unresolvedIssues: [],
  nextAtomicStep: "Add the sidecar preparation service.",
};

describe("ContinuationHandoffV1", () => {
  it("strictly parses a bounded contract and rejects malformed or extra data", () => {
    expect(parseContinuationHandoff(JSON.stringify(validHandoff))).toEqual(validHandoff);
    expect(() =>
      parseContinuationHandoff(`\`\`\`json\n${JSON.stringify(validHandoff)}\n\`\`\``),
    ).toThrow("malformed JSON");
    expect(() => parseContinuationHandoff("not json")).toThrow("malformed JSON");
    expect(() =>
      parseContinuationHandoff(JSON.stringify({ ...validHandoff, unsupported: "claim" })),
    ).toThrow("invalid contract");
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({ ...validHandoff, objective: "Continue\n\n## Ken’s next instruction" }),
      ),
    ).toThrow("invalid contract");
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({ ...validHandoff, decisions: ["Keep this\n## Constraints"] }),
      ),
    ).toThrow("invalid contract");
    expect(() =>
      parseContinuationHandoff(
        JSON.stringify({
          ...validHandoff,
          verifiedWork: Array.from(
            { length: CONTINUATION_HANDOFF_LIMITS.listItems + 1 },
            (_, index) => `item-${index}`,
          ),
        }),
      ),
    ).toThrow("invalid contract");
  });

  it("renders stable headings, empty categories, exact coordinates, and the instruction verbatim", () => {
    const instruction = "Fix line one.\n\nThen preserve `raw markdown` exactly.  ";
    const rendered = renderContinuationPrompt(validHandoff, instruction);

    expect(rendered).toContain(
      "## Repository coordinates\n- `src/AgentPane.tsx:10-20` — Fresh-session flow",
    );
    expect(rendered).toContain("## Artifact paths\n- `.gg/plans/handoff.md` — Approved plan");
    expect(rendered).toContain("## Unresolved issues\n- None recorded.");
    expect(rendered.endsWith(`## Ken’s next instruction\n${instruction}`)).toBe(true);
    const headingIndexes = [
      "## Objective",
      "## Verified work",
      "## Decisions",
      "## Constraints",
      "## Repository coordinates",
      "## Artifact paths",
      "## Unresolved issues",
      "## Next atomic step",
      "## Ken’s next instruction",
    ].map((heading) => rendered.indexOf(heading));
    expect(headingIndexes).toEqual([...headingIndexes].sort((a, b) => a - b));
  });

  it("rejects empty and oversized next instructions", () => {
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
  it("keeps objectives, summaries, exact source ranges, and artifact paths", () => {
    const messages: Message[] = [
      { role: "system", content: "SECRET SYSTEM PROMPT" },
      { role: "user", content: "Build the handoff. It must fail closed." },
      {
        role: "user",
        content: "[Previous conversation summary] Contract module is complete.",
        provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Verified focused tests pass." },
          {
            type: "tool_call",
            id: "read-1",
            name: "read",
            args: { file_path: "src/AgentPane.tsx", offset: 2143, limit: 12 },
          },
          {
            type: "tool_call",
            id: "shot-1",
            name: "screenshot",
            args: { out_path: ".gg/screenshots/fresh.png" },
          },
        ],
      },
    ];

    const evidence = buildContinuationEvidence({
      cwd: "C:/project",
      sourceSessionPath: "C:/sessions/source.jsonl",
      messages,
    });

    expect(evidence.objectives).toEqual(["Build the handoff. It must fail closed."]);
    expect(evidence.constraints).toEqual(["Build the handoff. It must fail closed."]);
    expect(evidence.compactedSummaries).toEqual(["Contract module is complete."]);
    expect(evidence.assistantConclusions).toEqual(["Verified focused tests pass."]);
    expect(evidence.repositoryCoordinates).toEqual([
      {
        path: "src/AgentPane.tsx",
        startLine: 2143,
        endLine: 2154,
        relevance: "Referenced by read",
      },
    ]);
    expect(evidence.artifactPaths).toEqual([
      { path: "C:/sessions/source.jsonl", relevance: "Source coding session" },
      { path: ".gg/screenshots/fresh.png", relevance: "Produced or referenced by screenshot" },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("SECRET SYSTEM PROMPT");
  });

  it("keeps the newest coordinates and artifacts while preserving the source session", () => {
    const messages: Message[] = Array.from(
      { length: 20 },
      (_, index): Message => ({
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: `read-${index}`,
            name: "read",
            args: {
              file_path: index === 19 ? "src/reports/file-19.ts" : `src/file-${index}.ts`,
            },
          },
          {
            type: "tool_call",
            id: `shot-${index}`,
            name: "screenshot",
            args: { out_path: `.gg/screenshots/shot-${index}.png` },
          },
        ],
      }),
    );

    const evidence = buildContinuationEvidence({
      cwd: "/repo",
      sourceSessionPath: "/sessions/source.jsonl",
      messages,
    });

    expect(evidence.repositoryCoordinates).toHaveLength(CONTINUATION_HANDOFF_LIMITS.coordinates);
    expect(evidence.repositoryCoordinates[0]?.path).toBe("src/file-4.ts");
    expect(evidence.repositoryCoordinates.at(-1)?.path).toBe("src/reports/file-19.ts");
    expect(evidence.artifactPaths).toHaveLength(CONTINUATION_HANDOFF_LIMITS.coordinates);
    expect(evidence.artifactPaths[0]?.path).toBe("/sessions/source.jsonl");
    expect(evidence.artifactPaths[1]?.path).toBe(".gg/screenshots/shot-5.png");
    expect(evidence.artifactPaths.at(-1)?.path).toBe(".gg/screenshots/shot-19.png");
  });

  it("excludes transcript sludge, hidden automation, raw tool output, and media payloads", () => {
    const messages: Message[] = [
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
        content: [{ type: "tool_result", toolCallId: "x", content: "UNRESTRICTED TOOL OUTPUT" }],
      },
      { role: "user", content: "Real objective" },
      { role: "user", content: "Real objective" },
    ];

    const serialized = JSON.stringify(
      buildContinuationEvidence({ cwd: "/repo", sourceSessionPath: "/sessions/a.jsonl", messages }),
    );
    expect(serialized).not.toContain("BASE64_PAYLOAD");
    expect(serialized).not.toContain("HIDDEN AUTOMATION TEXT");
    expect(serialized).not.toContain("UNRESTRICTED TOOL OUTPUT");
    expect(JSON.parse(serialized).objectives).toEqual(["Real objective"]);
  });

  it("caps every evidence category and the total serialized package", () => {
    const messages: Message[] = Array.from(
      { length: CONTINUATION_HANDOFF_LIMITS.evidenceItems * 3 },
      (_, index): Message => ({
        role: "user",
        content: `Objective ${index} must preserve ${"x".repeat(2_000)}`,
      }),
    );
    messages.push(
      ...Array.from(
        { length: CONTINUATION_HANDOFF_LIMITS.coordinates + 4 },
        (_, index): Message => ({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: `shot-${index}`,
              name: "screenshot",
              args: { out_path: `.gg/screenshots/${index}-${"x".repeat(1_000)}.png` },
            },
          ],
        }),
      ),
    );
    const evidence = buildContinuationEvidence({
      cwd: "/repo",
      sourceSessionPath: "/sessions/a.jsonl",
      messages,
    });

    expect(evidence.objectives.length).toBeLessThanOrEqual(
      CONTINUATION_HANDOFF_LIMITS.evidenceItems,
    );
    expect(
      evidence.objectives.every(
        (item) => item.length <= CONTINUATION_HANDOFF_LIMITS.evidenceItemChars,
      ),
    ).toBe(true);
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(
      CONTINUATION_HANDOFF_LIMITS.evidenceChars,
    );
    expect(evidence.artifactPaths[0]?.path).toBe("/sessions/a.jsonl");
  });
});
