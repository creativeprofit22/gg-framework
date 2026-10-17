import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createResearchCorpusTool } from "./research-corpus.js";
import { renderResearchPolicy, RESEARCH_EVIDENCE_GUIDANCE } from "../core/research-policy.js";
const execute = vi.hoisted(() => vi.fn(async () => "retrieved source"));
vi.mock("./steroids.js", () => ({
  createSteroidsTool: () => ({
    name: "steroids",
    description: "fixture",
    parameters: z.object({
      action: z.string(),
      add: z.boolean().optional(),
      repos: z.array(z.string()).optional(),
    }),
    execute,
  }),
}));
const context = { signal: new AbortController().signal, toolCallId: "research-fixture" };
it.each([
  { action: "add" },
  { action: "discover", add: true },
  { action: "show", repos: ["owner/repo"] },
  { action: "install" },
])("denies corpus mutation %j before underlying execution", async (args) => {
  execute.mockClear();
  await expect(createResearchCorpusTool("fixture").execute(args, context)).rejects.toThrow(
    "Corpus mutation",
  );
  expect(execute).not.toHaveBeenCalled();
});
it.each(["search", "define", "show", "files", "repos", "discover", "recent"])(
  "reuses the existing facade execution for %s",
  async (action) => {
    execute.mockClear();
    expect(await createResearchCorpusTool("fixture").execute({ action }, context)).toBe(
      "retrieved source",
    );
    expect(execute).toHaveBeenCalledWith({ action }, context);
  },
);
it("shares a conditional local-first policy across workflow uses without mandatory research", () => {
  const policy = renderResearchPolicy() + RESEARCH_EVIDENCE_GUIDANCE;
  expect(createResearchCorpusTool("fixture").description).toContain(RESEARCH_EVIDENCE_GUIDANCE);
  for (const use of [
    "assessment",
    "recommendations/manual alternatives",
    "command design questions",
    "execution uncertainty",
    "review/maintenance",
  ])
    expect(policy).toContain(use);
  expect(policy).toContain("local code and installed source first");
  expect(policy).toContain("leads, not inspected-code evidence");
  expect(policy).toContain("no external research is required");
  expect(policy).toContain("cannot add repositories");
});
