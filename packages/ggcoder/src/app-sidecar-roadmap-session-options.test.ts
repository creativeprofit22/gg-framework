import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT } from "./app-sidecar-roadmap-draft-tool-host.js";
import {
  createAppSidecarChatRoadmapSessionOptions,
  createAppSidecarCodingRoadmapSessionOptions,
} from "./app-sidecar-roadmap-session-options.js";

function tool(name: string): AgentTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    execute: () => name,
  };
}

describe("app-sidecar Roadmap session options", () => {
  it("registers binding only for coding sessions with existing Roadmap tools", () => {
    const options = createAppSidecarCodingRoadmapSessionOptions(
      [tool("roadmap_status")],
      [tool("roadmap_inspect"), tool("roadmap_phase_draft")],
      [tool("roadmap_bind")],
    );

    expect(options.additionalTools?.map((candidate) => candidate.name)).toEqual([
      "roadmap_status",
      "roadmap_inspect",
      "roadmap_phase_draft",
      "roadmap_bind",
    ]);
    expect(options.getSystemPromptTail?.()).toBe(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
  });

  it("hosts only inspect and phase draft for Research chat", () => {
    const options = createAppSidecarChatRoadmapSessionOptions([
      tool("roadmap_inspect"),
      tool("roadmap_phase_draft"),
    ]);

    expect(Object.keys(options.additionalToolsByAgent ?? {})).toEqual(["research"]);
    expect(options.additionalToolsByAgent?.research?.map((candidate) => candidate.name)).toEqual([
      "roadmap_inspect",
      "roadmap_phase_draft",
    ]);
    expect(options.additionalToolsByAgent?.general).toBeUndefined();
    expect(options.additionalToolsByAgent?.therapist).toBeUndefined();
    expect(options.getSystemPromptTailForAgent?.("general")).toBe("");
    expect(options.getSystemPromptTailForAgent?.("therapist")).toBe("");
    expect(options.getSystemPromptTailForAgent?.("research")).toBe(
      APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
    );
  });
});
