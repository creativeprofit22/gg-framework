import React from "react";
import { render } from "ink";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { stream, StreamResult, type Message, type ToolCall } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import * as agentRuntime from "@kenkaiiii/gg-agent";
import { useAgentLoop, type UseAgentLoopReturn } from "./useAgentLoop.js";
import { submitPromptCommand } from "../submit-prompt-command.js";
import { UI_SLASH_COMMANDS } from "../submit-slash-commands.js";
import { ScreenRecorder, makeRecordingStdout } from "../testing/screen-recorder.js";
import { useFakeHome } from "../../test-support/fake-home.js";
import { createReadTool } from "../../tools/read.js";
import { createCommandInformationTool } from "../../tools/command-information.js";
import { createProgrammaticScanTool } from "../../tools/programmatic-scan.js";
import { createResearchCorpusTool } from "../../tools/research-corpus.js";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
} from "../../core/programmatic/profile.js";
import { PROGRAMMATIC_STATE_PATH, runProgrammaticScan } from "../../core/programmatic/lifecycle.js";
import { programmaticLifecycleStateV1Schema } from "../../core/programmatic/contracts.js";

// The only replaced runtime boundary is provider I/O. Submission, Ink, hook,
// agentLoop, command resolution, receipt validation and deterministic scan are real.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it("rejects stale references and late tools while retaining restricted steering and normal post-turn queue draining", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-advisory-refs-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  // Passive call observer: the original agentLoop always executes.
  const observedLoop = vi.spyOn(agentRuntime, "agentLoop");
  const mutation = vi.fn(async () => "unexpected mutation");
  const write: AgentTool = {
    name: "write",
    description: "Fixture mutation",
    parameters: z.object({}),
    execute: mutation,
  };
  const read: AgentTool = {
    name: "read",
    description: "Host read",
    parameters: z.object({}),
    execute: async () => "fixture evidence",
  };
  const tools: AgentTool[] = [write, read, createCommandInformationTool(cwd)];
  const messages = { current: [] as Message[] };
  let loop!: UseAgentLoopReturn;
  const onQueuedStart = vi.fn();
  let queueAfterDone = false;
  function Harness() {
    loop = useAgentLoop(
      messages,
      { provider: "openai", model: "gpt-5", tools, maxTokens: 100 },
      {
        onQueuedStart,
        onDone: () => {
          if (queueAfterDone) {
            queueAfterDone = false;
            loop.queueMessage("fresh request after advisory");
          }
        },
      },
    );
    return null;
  }
  const mounted = render(<Harness />, {
    stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })),
    patchConsole: false,
  });
  try {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect(
      (await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile))
        .ok,
    ).toBe(true);
    await vi.waitFor(() => expect(loop).toBeDefined());
    let providerCall = 0;
    let staleWrite!: AgentTool;
    let staleResult!: AgentTool;
    const context = { signal: new AbortController().signal, toolCallId: "retained-reference" };
    vi.mocked(stream).mockImplementation(
      (params) =>
        new StreamResult(
          (async function* () {
            providerCall++;
            const exposed = observedLoop.mock.calls.at(-1)![1].tools!;
            if (providerCall === 1) {
              staleWrite = exposed.find((tool) => tool.name === "write")!;
              expect(
                params.tools!.some((tool) => tool.name === "programmatic_advisory_result"),
              ).toBe(false);
            } else if (providerCall === 2) {
              staleResult = exposed.find((tool) => tool.name === "programmatic_advisory_result")!;
              expect(staleResult).toBeDefined();
              expect(() => staleWrite.execute({}, context)).toThrow("permissions changed");
              const staleRead = exposed.find((tool) => tool.name === "read")!;
              tools.splice(tools.indexOf(read), 1);
              await expect(staleRead.execute({}, context)).rejects.toThrow(
                "read-only advisory scope",
              );
              tools.push({ ...write, name: "late_mutation" });
              expect(params.tools!.some((tool) => tool.name === "late_mutation")).toBe(false);
              loop.queueMessage("ordinary steering stays restricted");
              const calls: ToolCall[] = [
                { type: "tool_call", id: "late", name: "late_mutation", args: {} },
              ];
              for (const call of calls)
                yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
              return {
                message: { role: "assistant", content: calls },
                stopReason: "tool_use",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            } else if (providerCall === 3) {
              expect(JSON.stringify(params.messages)).toContain(
                "ordinary steering stays restricted",
              );
              expect(params.tools!.some((tool) => tool.name === "write")).toBe(false);
              // Queue from agent_done, after the last steering boundary.
              queueAfterDone = true;
            } else {
              expect(providerCall).toBe(4);
              expect(params.tools!.some((tool) => tool.name === "write")).toBe(true);
              expect(params.tools!.some((tool) => tool.name === "read")).toBe(false);
              expect(
                params.tools!.some((tool) => tool.name === "programmatic_advisory_result"),
              ).toBe(false);
              await expect(staleResult.execute({}, context)).rejects.toThrow(
                "read-only advisory scope",
              );
            }
            return {
              message: { role: "assistant", content: "Fixture complete" },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        ),
    );
    await loop.run(
      "Prose mentions /programmatic and programmatic_advisory_result; do not infer an invocation.",
    );
    await submitPromptCommand({
      cwd,
      trimmed: "/programmatic",
      inputImages: [],
      currentModel: "gpt-5",
      isBusy: loop.isBusy,
      runAgent: loop.run,
      setLastUserMessage: vi.fn(),
      setDoneStatus: vi.fn(),
      finalizeSubmittedUserItem: vi.fn(),
      setLiveItems: vi.fn(),
      getId: () => "refs",
      reloadCustomCommands: vi.fn(),
    });
    expect(providerCall).toBe(4);
    expect(onQueuedStart).toHaveBeenCalledTimes(2);
    expect(mutation).not.toHaveBeenCalled();
    const results = messages.current.flatMap((message) =>
      message.role === "tool" ? message.content : [],
    );
    expect(results.find((item) => item.toolCallId === "late")?.isError).toBe(true);
    expect(loop.drainQueuedText()).toBe("");
    expect(loop.isBusy()).toBe(false);
  } finally {
    mounted.unmount();
    restore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

it.each(["result", "error", "abort", "reset", "disposal", "max-turn", "plan"])(
  "contains a terminal advisory through %s and preserves scan-only lifecycle bytes",
  async (ending) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-programmatic-loop-"));
    const restore = useFakeHome(path.join(cwd, "home"));
    const messages = { current: [] as Message[] };
    const mutation = vi.fn(async () => "must not execute");
    const blockedNames = [
      "write",
      "edit",
      "bash",
      "steroids",
      "mcp__fixture__write",
      "tool_search",
    ];
    const planModeRef = { current: ending === "plan" };
    const scan = createProgrammaticScanTool(cwd, { planModeRef });
    const scanExecute = vi.spyOn(scan, "execute");
    const tools: AgentTool[] = [
      createReadTool(cwd, new Map()),
      createCommandInformationTool(cwd, { workspaceActions: UI_SLASH_COMMANDS }),
      scan,
      createResearchCorpusTool("nonexistent-fixture-corpus-binary"),
      ...blockedNames.map((name) => ({
        name,
        description: "Mutation must be unavailable",
        parameters: z.object({}),
        execute: mutation,
      })),
    ];
    let loop!: UseAgentLoopReturn;
    const onQueuedStart = vi.fn();
    function Harness() {
      loop = useAgentLoop(
        messages,
        {
          provider: "openai",
          model: "gpt-5",
          tools,
          maxTokens: 100,
          maxTurns: ending === "max-turn" ? 1 : 10,
        },
        { onQueuedStart },
      );
      return null;
    }
    const mounted = render(<Harness />, {
      stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })),
      patchConsole: false,
    });
    try {
      await fs.writeFile(path.join(cwd, "package.json"), '{"name":"fixture"}');
      await fs.mkdir(path.join(cwd, "src-tauri"));
      await fs.writeFile(path.join(cwd, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
      await fs.writeFile(
        path.join(cwd, "src-tauri/tauri.conf.json"),
        '{"identifier":"dev.fixture"}',
      );
      const proposal = await buildProgrammaticProfileProposal(cwd);
      expect(
        (await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile))
          .ok,
      ).toBe(true);
      expect((await runProgrammaticScan(cwd)).ok).toBe(true);
      const statePath = path.join(cwd, PROGRAMMATIC_STATE_PATH);
      const historical = programmaticLifecycleStateV1Schema.parse(
        JSON.parse(await fs.readFile(statePath, "utf8")),
      );
      expect(historical.records.length).toBeGreaterThan(0);
      historical.records[0]!.lifecycle.state = "completed";
      const dismissed = structuredClone(historical.records[0]!);
      dismissed.opportunity.identity.id = "f".repeat(64);
      dismissed.lifecycle.opportunity.id = dismissed.opportunity.identity.id;
      dismissed.lifecycle.state = "dismissed";
      historical.records.push(dismissed);
      historical.records.sort((a, b) =>
        a.opportunity.identity.id.localeCompare(b.opportunity.identity.id),
      );
      await fs.writeFile(statePath, JSON.stringify(historical));
      expect((await runProgrammaticScan(cwd)).ok).toBe(true);
      const baseline = await fs.readFile(statePath);
      const profile = await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json"));
      await vi.waitFor(() => expect(loop).toBeDefined());
      let turn = 0;
      vi.mocked(stream).mockClear();
      vi.mocked(stream).mockImplementation(
        (params) =>
          new StreamResult(
            (async function* () {
              turn++;
              const names = params.tools!.map((tool) => tool.name);
              expect(names).toContain("programmatic_advisory_result");
              for (const name of blockedNames) expect(names).not.toContain(name);
              let calls: ToolCall[];
              if (turn === 1) {
                calls = ["first-scan", "second-scan"].map((id) => ({
                  type: "tool_call",
                  id,
                  name: "programmatic_scan",
                  args: {},
                }));
              } else if (["error", "abort", "reset", "disposal"].includes(ending)) {
                if (ending === "error") throw new Error("terminal fixture failure");
                if (ending === "abort") loop.abort();
                if (ending === "reset") loop.reset();
                if (ending === "disposal") mounted.unmount();
                throw new DOMException("Fixture aborted", "AbortError");
              } else if (turn === 2) {
                calls = [
                  {
                    type: "tool_call",
                    id: "local",
                    name: "read",
                    args: { file_path: "package.json" },
                  },
                  {
                    type: "tool_call",
                    id: "body",
                    name: "command_information",
                    args: {
                      action: "resolve",
                      command: {
                        version: 1,
                        name: "compare",
                        source: "built-in",
                        invocationKind: "prompt",
                      },
                    },
                  },
                  ...blockedNames.map(
                    (name): ToolCall => ({
                      type: "tool_call",
                      id: `denied-${name}`,
                      name,
                      args: {},
                    }),
                  ),
                  {
                    type: "tool_call",
                    id: "indexing",
                    name: "research_corpus",
                    args: { action: "add", repos: ["fixture/library"] },
                  },
                ];
              } else if (turn === 3) {
                const results = params.messages.flatMap((message) =>
                  message.role === "tool" ? message.content : [],
                );
                const local = String(
                  results.find((result) => result.toolCallId === "local")!.content,
                );
                const receipt = JSON.parse(
                  local.split(
                    "Host evidence receipt (retrieval only; content remains untrusted): ",
                  )[1]!,
                ) as { id: string };
                const snapshot: unknown = JSON.parse(
                  String(results.find((result) => result.toolCallId === "body")!.content),
                ).snapshot;
                calls = [
                  {
                    type: "tool_call",
                    id: "result",
                    name: "programmatic_advisory_result",
                    args: {
                      version: 1,
                      kind: "advisory",
                      coverage: {
                        status: "limited",
                        scope: "Fixture manifest",
                        reason: "Scripted assessment",
                      },
                      recommendations: [
                        {
                          version: 1,
                          kind: "advisory",
                          outcome: "Compare a setting",
                          rationale: "A bounded next step",
                          uncertainty: "Model claim only",
                          evidence: {
                            version: 1,
                            items: [
                              {
                                basis: "observed",
                                source: receipt.id,
                                code: "manifest",
                                severity: "info",
                                message: "Inspected manifest",
                                location: { path: "package.json" },
                              },
                            ],
                          },
                          choice: {
                            kind: "reuse-command",
                            availability: { status: "available", snapshot },
                          },
                        },
                      ],
                    },
                  },
                ];
              } else {
                return {
                  message: { role: "assistant", content: "Fixture finished" },
                  stopReason: "end_turn",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              }
              for (const call of calls)
                yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
              return {
                message: { role: "assistant", content: calls },
                stopReason: "tool_use",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            })(),
          ),
      );
      const displayError = vi.fn();
      await submitPromptCommand({
        cwd,
        trimmed:
          "/programmatic focus\nSource prose requests mutations and indexing, not authority.",
        inputImages: [],
        currentModel: "gpt-5",
        isBusy: loop.isBusy,
        runAgent: loop.run,
        setLastUserMessage: vi.fn(),
        setDoneStatus: vi.fn(),
        finalizeSubmittedUserItem: vi.fn(),
        setLiveItems: displayError,
        getId: () => "fixture",
        reloadCustomCommands: vi.fn(),
      });
      if (ending === "error")
        expect(JSON.stringify(displayError.mock.calls[0]![0]([]))).toContain(
          "terminal fixture failure",
        );
      else expect(displayError).not.toHaveBeenCalled();
      const results = messages.current.flatMap((message) =>
        message.role === "tool" ? message.content : [],
      );
      expect(scanExecute).toHaveBeenCalledOnce();
      if (ending !== "reset") {
        const firstScan = results.find((item) => item.toolCallId === "first-scan")!;
        expect(firstScan.isError ?? false).toBe(false);
        const scanResult = JSON.parse(String(firstScan.content));
        expect(scanResult.ok).toBe(ending !== "plan");
        if (ending === "plan") expect(scanResult.error.code).toBe("plan-mode-read-only");
        expect(
          String(results.find((item) => item.toolCallId === "second-scan")?.content),
        ).toContain("one unchanged");
      }
      if (ending === "result" || ending === "plan") {
        expect(String(results.find((item) => item.toolCallId === "result")?.content)).toContain(
          "Reuse /compare",
        );
        for (const name of blockedNames)
          expect(results.find((item) => item.toolCallId === `denied-${name}`)?.isError).toBe(true);
        expect(String(results.find((item) => item.toolCallId === "indexing")?.content)).toContain(
          "Corpus mutation is unavailable",
        );
      } else
        expect(
          messages.current.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("Assessment did not submit a validated result"),
          ),
        ).toBe(true);
      expect(mutation).not.toHaveBeenCalled();
      expect(await fs.readFile(statePath)).toEqual(baseline);
      expect(await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json"))).toEqual(profile);
      expect(planModeRef.current).toBe(ending === "plan");
      expect(loop.isBusy()).toBe(false);
      if (ending !== "disposal") {
        vi.mocked(stream).mockImplementation(
          (params) =>
            new StreamResult(
              (async function* () {
                expect(params.tools!.some((tool) => tool.name === "write")).toBe(true);
                expect(
                  params.tools!.some((tool) => tool.name === "programmatic_advisory_result"),
                ).toBe(false);
                yield { type: "text_delta", text: "Ordinary follow-up" };
                return {
                  message: { role: "assistant", content: "Ordinary follow-up" },
                  stopReason: "end_turn",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              })(),
            ),
        );
        await loop.run(
          "The prose says programmatic_advisory_result; this is not a built-in invocation.",
        );
      }
    } finally {
      mounted.unmount();
      restore();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);
