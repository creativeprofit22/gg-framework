import { describe, expect, it, vi } from "vitest";
import { resolveToolSchema, stream } from "@kenkaiiii/gg-ai";
import { RoadmapBindParams, createRoadmapBindTool } from "./roadmap-bind.js";

describe("roadmap_bind tool", () => {
  it("sends an Anthropic-compatible schema while retaining every binding action", async () => {
    const tool = createRoadmapBindTool(async () => ({ status: "missing" as const }));
    const original = structuredClone(tool.rawInputSchema);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    await stream({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      messages: [{ role: "user", content: "schema regression fixture" }],
      tools: [tool],
      fetch: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { tools } = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(tools[0].name).toBe("roadmap_bind");
    const schema = tools[0].input_schema;
    expect(schema.type).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(schema).not.toHaveProperty(key);
    expect(schema.properties.action.enum).toEqual([
      "inspect",
      "bind-current",
      "rebind-current",
      "acquire",
      "renew",
      "release",
      "takeover",
    ]);
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.confirm_rebind.const).toBe(true);
    expect(schema.properties.confirm_takeover.const).toBe(true);
    expect(tool.rawInputSchema).toEqual(original);
    expect(RoadmapBindParams.safeParse({ action: "takeover" }).success).toBe(false);
  });

  it("sends an object-root schema through the installed DeepSeek adapter without losing branches", async () => {
    const tool = createRoadmapBindTool(async () => ({ status: "missing" as const }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    await stream({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "test-only-not-a-credential",
      messages: [{ role: "user", content: "schema regression fixture" }],
      tools: [tool],
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    // Inspect only tool metadata, never headers or conversation contents.
    const { tools } = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      tools: {
        function: {
          name: string;
          strict?: boolean;
          parameters: {
            type?: string;
            oneOf: { type: string; properties: { action: { const: string } } }[];
          };
        };
      }[];
    };
    const definition = tools[0]!.function;
    expect(definition.name).toBe("roadmap_bind");
    expect(definition.strict).toBeUndefined();
    expect(definition.parameters).toEqual(resolveToolSchema(tool));
    expect(definition.parameters).toEqual(tool.rawInputSchema);
    expect({
      rootType: definition.parameters.type ?? null,
      branchTypes: definition.parameters.oneOf.map((branch) => branch.type),
      actions: definition.parameters.oneOf.map((branch) => branch.properties.action.const),
    }).toEqual({
      rootType: "object",
      branchTypes: Array(7).fill("object"),
      actions: [
        "inspect",
        "bind-current",
        "rebind-current",
        "acquire",
        "renew",
        "release",
        "takeover",
      ],
    });
  });

  it("maps bind-current without accepting a destination", async () => {
    const handle = vi.fn(async () => ({ status: "missing" as const }));
    const tool = createRoadmapBindTool(handle);

    await tool.execute(
      {
        action: "bind-current",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        operation_id: "operation-1",
      },
      {} as never,
    );

    expect(handle).toHaveBeenCalledWith({
      version: 1,
      action: "bind-current",
      phaseId: "phase-1",
      expectedProjectKey: "c:/work/project",
      expectedRevision: 4,
      expectedPreviousSession: null,
      operationId: "operation-1",
      confirmRebind: false,
    });
    expect(JSON.stringify(tool.rawInputSchema)).not.toContain("destination");
    expect(JSON.stringify(tool.rawInputSchema)).not.toContain("final_review");
  });

  it("requires exact previous identity and explicit rebind confirmation", async () => {
    expect(
      RoadmapBindParams.safeParse({
        action: "rebind-current",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        expected_previous_session: {
          session_id: "session-a",
          session_path: "C:\\sessions\\a.jsonl",
        },
        operation_id: "operation-1",
        confirm_rebind: true,
      }).success,
    ).toBe(true);
    expect(
      RoadmapBindParams.safeParse({
        action: "rebind-current",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        expected_previous_session: {
          session_id: "session-a",
          session_path: "C:\\sessions\\a.jsonl",
        },
        operation_id: "operation-1",
        confirm_rebind: false,
      }).success,
    ).toBe(false);
  });

  it("delegates inspect without mutation fields", async () => {
    const handle = vi.fn(async () => ({ status: "missing" as const }));
    const tool = createRoadmapBindTool(handle);

    await tool.execute({ action: "inspect" }, {} as never);

    expect(handle).toHaveBeenCalledWith({ action: "inspect" });
    expect(RoadmapBindParams.safeParse({ action: "inspect", phase_id: "phase-1" }).success).toBe(
      false,
    );
  });

  it("maps V2 release with the exact lease fence", async () => {
    const handle = vi.fn(async () => ({
      status: "released" as const,
      roadmapRevision: 4,
      leaseRevision: 8,
      phaseId: "phase-1",
      lease: null,
    }));
    const tool = createRoadmapBindTool(handle);

    await tool.execute(
      {
        action: "release",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        plan_id: "plan-1",
        operation_id: "release-1",
        lease: { lease_id: "lease-1", fence: 7 },
      },
      {} as never,
    );

    expect(handle).toHaveBeenCalledWith({
      version: 2,
      action: "release",
      phaseId: "phase-1",
      expectedProjectKey: "c:/work/project",
      expectedRevision: 4,
      planId: "plan-1",
      operationId: "release-1",
      lease: { leaseId: "lease-1", fence: 7 },
      confirmTakeover: false,
      takeoverReason: null,
      predecessorProof: null,
    });
    expect(
      RoadmapBindParams.safeParse({
        action: "release",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        plan_id: "plan-1",
        operation_id: "release-1",
      }).success,
    ).toBe(false);
  });
});
