import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeHome } from "../../test-support/fake-home.js";
import { executeDirectCommand, type DirectCommandExecutionOptions } from "./execution.js";
import type { AskUserRequest, AskUserResult } from "../ask-user.js";
import { AgentSession } from "../agent-session.js";
import { getGlobalCommandDirs } from "../custom-commands.js";
import { inspectCommandCreation, publishReviewedCommand } from "./command-creation.js";

let root: string;
let restore: () => void;
let requests: Record<string, unknown>[];
const url = "https://direct-fixture.invalid/openai/v1/responses";
const answer = async (request: AskUserRequest): Promise<AskUserResult> => {
  const q = request.questions[0]!;
  return { action: "answer", answers: { [q.id]: q.options![0]!.value! } };
};
function response(name?: string, args?: unknown, id = "call") {
  const item = { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) };
  const events = name ? [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
  ] : [{ type: "response.output_text.delta", delta: "Finished" }];
  return new Response([...events, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function options(extra: Partial<DirectCommandExecutionOptions> = {}): DirectCommandExecutionOptions {
  return {
    cwd: root, provider: "azure", model: "azure:fixture", baseUrl: url, signal: new AbortController().signal,
    ask: answer, cancelQuestions: vi.fn(), progress: vi.fn(), discovery: { readReadiness: async () => "missing" },
    availableTools: () => ["read", "bash"],
    selection: { version: 1, command: { version: 1, name: "fixture-check", source: "project-custom", invocationKind: "prompt" },
      arguments: "EXACT ARGUMENTS", outcome: "Inspect fixture", successCondition: "Fixture inspected", helpers: [], prerequisites: [],
      requiredTools: ["read"], mode: "read-only", containment: "agent-session" }, ...extra,
  };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-direct-execution-"));
  restore = useFakeHome(path.join(root, "home"));
  for (const directory of getGlobalCommandDirs()) await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(root, ".gg/commands"), { recursive: true });
  await fs.writeFile(path.join(root, ".gg/commands/fixture-check.md"), "---\nname: fixture-check\n---\nEXACT DIRECT PROMPT. Read package.json and report evidence.");
  await fs.writeFile(path.join(root, "package.json"), "{}");
  vi.stubEnv("AZURE_OPENAI_API_KEY", "fixture-not-a-credential");
  vi.stubEnv("AZURE_OPENAI_BASE_URL", url);
  vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "fixture");
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (target: unknown, init?: RequestInit) => {
    if (String(target) !== url) throw new Error("Unexpected fixture network");
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return response("read", { file_path: "package.json" }, "read");
    if (requests.length === 2) return response("programmatic_result", { summary: "Fixture inspected", successCondition: "Fixture inspected", toolCallIds: ["read"] }, "complete");
    return response();
  }));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); restore();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("direct execution through real AgentSession and tool dispatch", () => {
  it("runs one existing command without setup or creation, with bounded unverified provenance", async () => {
    const result = await executeDirectCommand(options());
    expect(result.status, result.summary).toBe("completed");
    expect(result.behavior).toBe("unverified");
    expect(result.evidence).toEqual([{ toolCallId: "read", tool: "read", basis: "tool-completed",
      argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/), resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(result.snapshot?.selection.command.name).toBe("fixture-check");
    expect(result.executionSha256).toMatch(/^[a-f0-9]{64}$/);
    const provider = JSON.stringify(requests);
    expect(provider).toContain("EXACT DIRECT PROMPT");
    expect(provider).toContain("EXACT ARGUMENTS");
    expect(JSON.stringify(requests[0]!.tools)).not.toMatch(/"name":"(?:bash|write|programmatic_command|steroids|spawn_agent)"/);
    await expect(fs.stat(path.join(root, ".gg/programmatic"))).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("EXACT DIRECT PROMPT");
  });
  it.each(["body", "frontmatter", "helper", "prerequisite", "policy"])("invalidates %s drift during initial review before provider dispatch", async (kind) => {
    await fs.writeFile(path.join(root, "helper.mjs"), "console.log('fixture');");
    let tools = ["read", "bash"];
    const input = options({ availableTools: () => tools, ask: async (request) => {
      if (kind === "policy") tools = ["read"];
      else if (kind === "frontmatter") {
        const file = path.join(root, ".gg/commands/fixture-check.md");
        await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("name: fixture-check", "name: fixture-check\ndescription: changed metadata"));
      }
      else await fs.appendFile(path.join(root, kind === "body" ? ".gg/commands/fixture-check.md" : kind === "helper" ? "helper.mjs" : "package.json"), "\n");
      return answer(request);
    } });
    input.selection = { ...input.selection, helpers: ["helper.mjs"], prerequisites: ["package.json"], mode: "general-work" };
    const result = await executeDirectCommand(input);
    expect(result.status).toBe("failed");
    expect(requests).toHaveLength(0);
  });
  it("rejects replayed and cross-run answers", async () => {
    let saved: AskUserResult | undefined;
    const ask = async (request: AskUserRequest) => saved ??= await answer(request);
    expect((await executeDirectCommand(options({ ask }))).status).toBe("completed");
    requests = [];
    expect((await executeDirectCommand(options({ ask }))).status).toBe("rejected");
    expect(requests).toHaveLength(0);
  });
  it("rejects a linked project owner before canonicalization can hide it", async () => {
    const linked = path.join(root, "linked-project");
    await fs.symlink(root, linked, "junction");
    const input = options({ cwd: linked, ask: vi.fn(answer) });
    expect((await executeDirectCommand(input)).status).toBe("rejected");
    expect(input.ask).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
  it("keeps the research specialist read-only through the direct entry", async () => {
    const global = getGlobalCommandDirs()[0]!;
    await fs.writeFile(path.join(global, "research.md"), "Read package.json and report evidence.");
    const input = options({ ask: vi.fn(answer) });
    input.selection = { ...input.selection, command: { version: 1, name: "research", source: "global-custom", invocationKind: "prompt" }, mode: "general-work" };
    expect((await executeDirectCommand(input)).status).toBe("rejected");
    expect(input.ask).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    input.selection.mode = "read-only";
    expect((await executeDirectCommand(input)).status).toBe("completed");
    expect(JSON.stringify(requests[0]!.tools)).not.toMatch(/"name":"(?:bash|write|edit|steroids)"/);
  });
  it("refuses unsupported tools and containment without asking or dispatching", async () => {
    for (const change of [{ requiredTools: ["write"] }, { containment: "os-confined" as const }]) {
      const input = options({ ask: vi.fn(answer) }); input.selection = { ...input.selection, ...change };
      expect((await executeDirectCommand(input)).status).toBe("rejected");
      expect(input.ask).not.toHaveBeenCalled();
    }
    expect(requests).toHaveLength(0);
  });
  it("keeps a waiting real parent conversation out of the isolated child", async () => {
    await fs.writeFile(path.join(root, "home/.gg/settings.json"), JSON.stringify({ deferredBuiltinTools: false, autoCompact: false, idealReviewEnabled: false }));
    let parentCalls = 0;
    const childRequests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_target: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (JSON.stringify(request.tools).includes('"name":"programmatic_result"')) {
        childRequests.push(request);
        if (childRequests.length === 1) return response("read", { file_path: "package.json" }, "read");
        if (childRequests.length === 2) return response("programmatic_result", { summary: "Fixture inspected", successCondition: "Fixture inspected", toolCallIds: ["read"] }, "complete");
        return response();
      }
      return ++parentCalls === 1 ? response("programmatic_command", { action: "run", selection: options().selection }, "direct") : response();
    }));
    const execute = vi.fn(async (request: Parameters<NonNullable<ConstructorParameters<typeof AgentSession>[0]["executeReviewedCommand"]>>[0]) => executeDirectCommand({ ...options(), ...request }));
    const parent = new AgentSession({ cwd: root, provider: "azure", model: "azure:fixture", baseUrl: url,
      signal: new AbortController().signal, backgroundMcpConnect: true, executeReviewedCommand: execute });
    try {
      await parent.initialize();
      await parent.prompt("PARENT HISTORY SENTINEL: run the fixture");
      expect(execute).toHaveBeenCalledOnce();
      expect((await execute.mock.results[0]!.value).status).toBe("completed");
      expect(childRequests.length).toBeGreaterThan(0);
      expect(JSON.stringify(childRequests)).not.toContain("PARENT HISTORY SENTINEL");
    } finally { await parent.dispose(undefined, true); }
  });
  it.each(["built-in", "global-custom"] as const)("executes an existing %s prompt through the same session", async (source) => {
    const input = options();
    if (source === "global-custom") {
      const global = getGlobalCommandDirs()[0]!;
      await fs.mkdir(global, { recursive: true });
      await fs.writeFile(path.join(global, "global-fixture.md"), "Read package.json and report evidence.");
    }
    input.selection.command = { version: 1, source, invocationKind: "prompt", name: source === "built-in" ? "setup-tauri-package" : "global-fixture" };
    expect((await executeDirectCommand(input)).status).toBe("completed");
  });
  it("runs a newly created helper only after independent run and exact action approvals", async () => {
    const host = { availableTools: () => ["bash"], readReadiness: async () => "missing" as const };
    const proposal = { name: "created-fixture", markdown: "## Inputs\nFixture\n## Outputs\nFixture output\n## Required tools\nbash\n## Limits\nReview first\n## Arguments\nAppended instructions\nRun node .gg/commands/created-fixture/helper.mjs.", requiredTools: ["bash"],
      helpers: [{ name: "helper.mjs", content: "console.log('harmless fixture');", repeatableLogic: "Print fixture" }],
      requirement: { version: 1, desiredOutcome: "Print fixture", capabilityKind: "script-backed", inputs: ["Fixture"], outputs: ["Fixture text"], prerequisites: ["Node"], risks: ["Shell access"], verificationExpectations: ["Print fixture"] } };
    const inventory = await inspectCommandCreation(root, proposal, host, new AbortController().signal);
    if (inventory.status !== "review-required") throw new Error(JSON.stringify(inventory));
    const reviewed = await inspectCommandCreation(root, { ...proposal, review: { inventorySha256: inventory.catalog.sha256, disposition: "create", rationale: "New helper fixture" } }, host, new AbortController().signal);
    if (reviewed.status !== "proposal") throw new Error(JSON.stringify(reviewed));
    expect((await publishReviewedCommand(reviewed.value, host, new AbortController().signal)).created).toBe(true);
    const helper = reviewed.value.files.find((file) => file.path.endsWith("helper.mjs"))!.path;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests.push({});
      if (requests.length === 1) return response("bash", { command: `node ${helper}` }, "helper");
      if (requests.length === 2) return response("programmatic_result", { summary: "Fixture printed", successCondition: "Fixture inspected", toolCallIds: ["helper"] }, "complete");
      return response();
    }));
    const ask = vi.fn(answer);
    const input = options({ ask });
    input.selection = { ...input.selection, command: { ...input.selection.command, name: "created-fixture" }, helpers: [helper], mode: "general-work", requiredTools: ["bash"] };
    const result = await executeDirectCommand(input);
    expect(result.status, result.summary).toBe("completed");
    expect(result.behavior).toBe("unverified");
    expect(result.evidence[0]).toMatchObject({ tool: "bash", toolCallId: "helper" });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]![0].questions[0]!.detail).toContain(helper);
  });
  it("retains repository ownership after disposal failure for a direct run", async () => {
    const dispose = AgentSession.prototype.dispose;
    const children: AgentSession[] = [];
    vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(async function (this: AgentSession) { children.push(this); throw new Error("fixture disposal failure"); });
    const first = await executeDirectCommand(options());
    expect(first.status).toBe("failed");
    expect(first.summary).toContain("cleanup-unresolved");
    const second = await executeDirectCommand(options());
    expect(second.status).toBe("rejected");
    expect(second.summary).toContain("already executing");
    await dispose.call(children[0]!, undefined, true);
  });
  it("cancels initial review without provider dispatch and releases a clean claim", async () => {
    const controller = new AbortController();
    const first = await executeDirectCommand(options({ signal: controller.signal, ask: async (request) => { controller.abort(); return answer(request); } }));
    expect(first.status).not.toBe("completed");
    expect(requests).toHaveLength(0);
    expect((await executeDirectCommand(options())).status).toBe("completed");
  });
  it.each(["write", "steroids", "programmatic_command"])("does not let a read-only provider dispatch %s", async (name) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests.push({});
      return requests.length === 1 ? response(name, { file_path: "denied.txt", content: "must not write" }, "denied") : response();
    }));
    const result = await executeDirectCommand(options());
    expect(result.status).toBe("failed");
    expect(result.evidence).toEqual([]);
    await expect(fs.stat(path.join(root, "denied.txt"))).rejects.toThrow();
  });
  it("rejects opaque success output without evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const result = await executeDirectCommand(options());
    expect(result.status).toBe("failed");
    expect(result.behavior).toBe("unverified");
  });
  it.each(["helper", "command", "frontmatter", "prerequisite"])("revalidates %s contents after the action approval wait", async (kind) => {
    await fs.writeFile(path.join(root, "helper.mjs"), "console.log('fixture');");
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests.push({});
      return requests.length === 1 ? response("bash", { command: "node helper.mjs" }, "helper") : response();
    }));
    let reviews = 0;
    const input = options({ ask: async (request) => {
      if (++reviews === 2) {
        const file = path.join(root, kind === "helper" ? "helper.mjs" : kind === "prerequisite" ? "package.json" : ".gg/commands/fixture-check.md");
        const before = await fs.readFile(file, "utf8");
        await fs.writeFile(file, kind === "frontmatter" ? before.replace("name: fixture-check", "name: fixture-check\ndescription: changed during review") : `${before}\n`);
      }
      return answer(request);
    } });
    input.selection = { ...input.selection, mode: "general-work", helpers: ["helper.mjs"], prerequisites: ["package.json"], requiredTools: ["bash"] };
    const result = await executeDirectCommand(input);
    expect(reviews).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.evidence).toEqual([]);
  });
});
