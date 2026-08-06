import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RoadmapInspectParams, createRoadmapInspectTool } from "./roadmap-inspect.js";

describe("RoadmapInspectParams", () => {
  it("accepts only a strictly empty object", () => {
    expect(RoadmapInspectParams.parse({})).toEqual({});
    expect(() => RoadmapInspectParams.parse({ unexpected: true })).toThrow();
  });
});

describe("createRoadmapInspectTool", () => {
  it("delegates inspection and returns compact JSON", async () => {
    const outcome = { status: "missing", projectKey: "project-1" } as const;
    const inspect = vi.fn(async () => outcome);
    const tool = createRoadmapInspectTool(inspect);

    await expect(tool.execute({}, {} as never)).resolves.toBe(JSON.stringify(outcome));
    expect(inspect).toHaveBeenCalledOnce();
    expect(tool.name).toBe("roadmap_inspect");
  });

  it("exports a strict transform-free empty provider schema and inspection guidance", () => {
    const tool = createRoadmapInspectTool(async () => ({
      status: "missing",
      projectKey: "project-1",
    }));
    const exportedSchema = (): Record<string, unknown> =>
      tool.rawInputSchema ?? (z.toJSONSchema(tool.parameters) as Record<string, unknown>);

    expect(exportedSchema).not.toThrow();
    expect(exportedSchema()).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(tool.description).toContain("before drafting");
    expect(tool.description).toContain("bounded Project Notes v3 Roadmap projection");
  });
});
