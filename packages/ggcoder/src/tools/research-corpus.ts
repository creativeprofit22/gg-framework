import type { AgentTool } from "@kenkaiiii/gg-agent";
import { createSteroidsTool } from "./steroids.js";
import { RESEARCH_EVIDENCE_GUIDANCE } from "../core/research-policy.js";

export function createResearchCorpusTool(bin: string): AgentTool {
  const tool = createSteroidsTool(bin);
  return {
    ...tool,
    name: "research_corpus",
    description:
      "Read-only corpus facade for steroids. Search, define, show, files, repos, discover (without add), and recent only. Indexing, downloads and installation are unavailable. " +
      RESEARCH_EVIDENCE_GUIDANCE,
    execute: async (args, context) => {
      const parsed = tool.parameters.parse(args);
      if (
        !["search", "define", "show", "files", "repos", "discover", "recent"].includes(
          parsed.action,
        ) ||
        parsed.add ||
        parsed.repos?.length
      ) {
        throw new Error("Corpus mutation is unavailable in isolated research.");
      }
      return tool.execute(parsed, context);
    },
  };
}
