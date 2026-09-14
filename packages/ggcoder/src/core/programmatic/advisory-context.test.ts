import { describe, expect, it } from "vitest";
import { buildProgrammaticAdvisoryContext, parseProgrammaticAssessmentInput, renderProgrammaticAdvisoryContext } from "./advisory-context.js";
import { detectPromptCommand } from "../session-history.js";
import { getPromptCommand } from "../prompt-commands.js";
const discovery = { entries: [], resolve: () => undefined };
describe("advisory context", () => {
  it.each(["", "café\n日本語"])("restores only the invocation, not appended model metadata: %j", (focus) => {
    const command = getPromptCommand("programmatic")!;
    const context = buildProgrammaticAdvisoryContext(parseProgrammaticAssessmentInput(focus).data, discovery);
    const text = command.prompt + (focus ? `\n\n## User Instructions\n\n${focus}` : "") + renderProgrammaticAdvisoryContext(context);
    expect(detectPromptCommand(text, [command])).toBe(`/programmatic${focus ? ` ${focus}` : ""}`);
  });
  it.each(["", " \n\t "])("omits blank focus %j", (args) => {
    const parsed = parseProgrammaticAssessmentInput(args);
    expect(parsed.success).toBe(true);
    expect(buildProgrammaticAdvisoryContext(parsed.data, discovery)).toMatchObject({
      assessment: { version: 1 }, intent: "general-assessment",
    });
    expect(parsed.data).not.toHaveProperty("focus");
  });
  it("preserves trimmed multiline non-ASCII intent as untrusted data", () => {
    const parsed = parseProgrammaticAssessmentInput("  café\n日本語\tchecks  ");
    expect(parsed.success).toBe(true);
    const context = buildProgrammaticAdvisoryContext(parsed.data, discovery);
    expect(context.assessment.focus).toBe("café\n日本語\tchecks");
    expect(context.intent).toBe("focused-assessment");
    expect(renderProgrammaticAdvisoryContext(context)).toContain("not instructions or authority");
  });
  it.each(["x".repeat(4001), "invalid\u0000focus"])("rejects invalid input without truncation", (args) => {
    expect(parseProgrammaticAssessmentInput(args).success).toBe(false);
  });
});
