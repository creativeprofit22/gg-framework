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
import { createProgrammaticProfileTool } from "../../tools/programmatic-profile.js";
import { createResearchCorpusTool } from "../../tools/research-corpus.js";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
} from "../../core/programmatic/profile.js";
import { PROGRAMMATIC_STATE_PATH, runProgrammaticScan } from "../../core/programmatic/lifecycle.js";
import { programmaticLifecycleStateV1Schema } from "../../core/programmatic/contracts.js";
import { readRecommendationHistory } from "../../core/programmatic/recommendation-history.js";
import { ProgrammaticAssessmentCoordinator, type ProgrammaticAssessmentOutcome } from "../../core/programmatic/assessment.js";
import { renderTerminalProgrammaticAssessment } from "./terminal-programmatic-presentation.js";
import * as storage from "../../core/programmatic/storage.js";

// Provider I/O is scripted; selected history cases inject storage failures/revocation.
// Submission, Ink, hook, agentLoop, command resolution, receipts and scans are real.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each(["unavailable", "denied", "cancelled", "failed"] as const)("retains material %s scan and history limits without emitting the projection", (status) => {
  const outcome: ProgrammaticAssessmentOutcome = { assessment: {
    version: 1, mode: "configured", status: "unavailable", summary: "Assessment is unavailable.",
    deterministic: { status, reason: `Saved checks ${status}. No retry was attempted.` },
    history: { status: "acknowledgement-unknown", assessmentId: "private-history-id", reason: "The save acknowledgement was lost. Check history before saving again." },
    coverage: [{ scope: "project", status: "unreadable", summary: "Some files could not be read safely." }],
    observations: [{ basis: "observed", message: "An observation", evidenceSources: ["private-receipt-id"] }],
    limitations: ["Permission was denied; omitted content was not checked."],
  } };
  const before = structuredClone(outcome);
  const text = renderTerminalProgrammaticAssessment(outcome, []);
  expect(text).toContain("Assessment is unavailable.");
  expect(text).toContain(`Saved checks ${status}. No retry was attempted.`);
  expect(text).toContain("save could not be confirmed; it may have succeeded.");
  expect(text).toContain("Check history before saving again.");
  expect(text).toContain("Permission was denied; omitted content was not checked.");
  expect(text).toContain("Some files could not be read safely.");
  expect(text).toContain("No retry or recommended work was started");
  expect(text).not.toMatch(/private-|"version"|"observations"/);
  expect(outcome).toEqual(before);
});

it("bounds oversized accepted display text without hiding scan/history failure or claiming full coverage", () => {
  const outcome: ProgrammaticAssessmentOutcome = { assessment: {
    version: 1, mode: "configured", status: "incomplete", summary: "Assessment did not finish.",
    deterministic: { status: "failed", reason: "Saved checks failed. No retry was attempted." },
    history: { status: "unsaved", assessmentId: "private-history-id", reason: "Saving was denied." },
    coverage: [], observations: [], limitations: Array.from({ length: 50 }, (_, index) => `${index}: ${"limit ".repeat(660)}`),
  }, advice: "Accepted advice\u001b\u0007\n" + "detail ".repeat(10_000) };
  const before = structuredClone(outcome);
  const text = renderTerminalProgrammaticAssessment(outcome, []);
  expect(text.length).toBeLessThan(10_000);
  expect(text).not.toMatch(/[\u001b\u0007]/);
  expect(text).toContain("Saved checks failed. No retry was attempted.");
  expect(text).toContain("assessment was not saved. Saving was denied.");
  expect(text).toContain("44 additional inspection limits");
  expect(text).toContain("some detail or caveats are omitted");
  expect(text).toContain("this summary is not approval");
  expect(outcome).toEqual(before);
});

it.each(["saved", "report-rendered", "legacy-v1", "legacy-v2", "disabled", "setup", "revoked", "profile-replaced", "cancelled", "reset", "save-failed", "incomplete",
  "acknowledgement-unknown", "cancel-at-commit", "reset-at-commit", "dispose-at-commit", "mode-at-commit", "tool-at-commit"] as const)("projects terminal history independently after a real assessment: %s", async (scenario) => {
  const assessed = vi.spyOn(ProgrammaticAssessmentCoordinator.prototype, "run");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-history-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  const messages = { current: [] as Message[] };
  const planModeRef = { current: false };
  const scan = createProgrammaticScanTool(cwd, { planModeRef });
  const scanCalls = vi.spyOn(scan, "execute");
  const profile = createProgrammaticProfileTool(cwd, { planModeRef });
  const profileCalls = vi.spyOn(profile, "execute");
  const tools = [createReadTool(cwd), createCommandInformationTool(cwd), scan, profile];
  let loop!: UseAgentLoopReturn;
  const onTurnText = vi.fn();
  function Harness() {
    loop = useAgentLoop(messages, { provider: "openai", model: "gpt-5", tools, planModeRef, maxTokens: 100 }, { onTurnText });
    return null;
  }
  const mounted = render(<Harness />, {
    stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })), patchConsole: false,
  });
  try {
    await fs.writeFile(path.join(cwd, "package.json"), '{"name":"history-fixture"}\n');
    const proposal = await buildProgrammaticProfileProposal(cwd, { offerHistory: !scenario.startsWith("legacy-") });
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile, {
      expectedPriorProfileDigest: proposal.expectedPriorProfileDigest, historyPolicy: proposal.historyPolicy,
      expectedRecoveryDigest: proposal.expectedRecoveryDigest,
    })).ok).toBe(true);
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    if (scenario === "legacy-v1") await fs.writeFile(profilePath, JSON.stringify({ version: 1,
      profile: proposal.profile, configurationFingerprint: proposal.configurationFingerprint }));
    if (scenario === "disabled") {
      const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
      profile.historyPolicy.enabled = false;
      await fs.writeFile(profilePath, JSON.stringify(profile));
    }
    const profileBefore = await fs.readFile(profilePath);
    let commitsAttempted = 0;
    if (scenario.endsWith("-at-commit") || scenario === "acknowledgement-unknown") {
      const replace = storage.replaceBoundedFile;
      vi.spyOn(storage, "replaceBoundedFile").mockImplementation(async (...args) => {
        if (args[1] === ".gg/programmatic/recommendations.json") {
          commitsAttempted++;
          if (scenario === "acknowledgement-unknown") {
            const operations = args[4];
            args[4] = { ...operations, rename: async (...paths) => {
              await operations.rename(...paths);
              throw new Error("Fixture acknowledgement lost after rename");
            } };
          } else {
            const assertCurrent = args[5].assertCurrent;
            expect(assertCurrent).toEqual(expect.any(Function));
            args[5] = { ...args[5], assertCurrent: () => {
              if (scenario === "cancel-at-commit") loop.abort();
              if (scenario === "reset-at-commit") loop.reset();
              if (scenario === "dispose-at-commit") mounted.unmount();
              if (scenario === "mode-at-commit") planModeRef.current = true;
              // Same name is not the original captured capability.
              if (scenario === "tool-at-commit") tools.splice(tools.indexOf(scan), 1, { ...scan });
              assertCurrent!();
            } };
          }
        }
        return replace(...args);
      });
    }
    if (scenario === "save-failed") await fs.mkdir(path.join(cwd, ".gg/programmatic/recommendations.json"));
    await vi.waitFor(() => expect(loop).toBeDefined());
    let turns = 0;
    const startedBefore = Date.now();
    let providerStarted = 0;
    let scannerBytes: Buffer | undefined;
    vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
      if (!providerStarted) providerStarted = Date.now();
      expect(params.tools?.some((tool) => /history.*(save|write)|recommendation.*(save|write)/.test(tool.name))).toBe(false);
      let call: ToolCall | undefined;
      if (++turns === 1) call = { type: "tool_call", id: "history-read", name: "read", args: { file_path: "package.json" } };
      else if (turns === 2 && scenario !== "incomplete") {
        const local = params.messages.flatMap((message) => message.role === "tool" ? message.content : []).find((result) => result.toolCallId === "history-read")!;
        const receipt = JSON.parse(String(local.content).split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]!) as { id: string };
        call = { type: "tool_call", id: "history-advice", name: "programmatic_advisory_result", args: {
          version: 2, kind: "advisory", coverage: { status: "limited", scope: "Manifest", reason: "Fixture only" },
          recommendations: [{ version: 2, kind: "advisory", outcome: "Review manifest", rationale: "Local evidence", uncertainty: "Not verified",
            evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "manifest", severity: "info", message: "Read manifest", location: { path: "package.json" } }] },
            workflow: { trigger: "A manifest change needs review", representativeCase: "Review this manifest", inputs: ["package.json"],
              currentProcess: ["Read manifest"], output: "Bounded review", successCheck: "Trace each observation to source",
              affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read-only; changes need separate approval",
              repeatability: { basis: "inferred", explanation: "Source changes may require review again" } },
            alternatives: [], choice: { kind: "manual", steps: ["Review separately"] } }],
        } };
      }
      if (call) {
        yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
        return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (scenario !== "setup") scannerBytes = await fs.readFile(path.join(cwd, PROGRAMMATIC_STATE_PATH));
      if (scenario === "profile-replaced") await fs.writeFile(profilePath, Buffer.concat([profileBefore, Buffer.from("\n")]));
      if (scenario === "revoked") {
        const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
        profile.historyPolicy.enabled = false;
        await fs.writeFile(profilePath, JSON.stringify(profile));
      }
      if (scenario === "cancelled") loop.abort();
      if (scenario === "reset") loop.reset();
      const content = scenario === "report-rendered"
        ? String(params.messages.flatMap((message) => message.role === "tool" ? message.content : []).find((result) => result.toolCallId === "history-advice")!.content)
        : "Finished fixture.";
      yield { type: "text_delta", text: content };
      return { message: { role: "assistant", content }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    })()));
    const guidance = vi.fn();
    expect(await submitPromptCommand({
      cwd, trimmed: scenario === "setup" ? "/setup-programmatic" : "/programmatic", inputImages: [], currentModel: "gpt-5",
      setLastUserMessage: vi.fn(), setDoneStatus: vi.fn(), finalizeSubmittedUserItem: vi.fn(), runAgent: loop.run,
      isBusy: loop.isBusy, setLiveItems: guidance, getId: () => "history-fixture", reloadCustomCommands: vi.fn(),
    })).toBe(true);
    const notices = messages.current.filter((message) => message.role === "assistant" && typeof message.content === "string" && message.content.startsWith("## Needs assessment\n\n"));
    if (scenario === "legacy-v1") {
      expect(notices).toHaveLength(0);
      expect(guidance).toHaveBeenCalledOnce();
      expect(JSON.stringify(guidance.mock.calls[0]![0]([]))).toContain("legacy upgrade");
      expect(turns).toBe(0);
      expect(scanCalls).not.toHaveBeenCalled();
      expect((await readRecommendationHistory(cwd)).status).toBe("missing");
      expect(await fs.readFile(profilePath)).toEqual(profileBefore);
      return;
    }
    expect(guidance).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(assessed).toHaveBeenCalledOnce();
    const outcome = await assessed.mock.results[0]!.value as ProgrammaticAssessmentOutcome;
    const { assessment } = outcome;
    const presentation = String(notices[0]!.content);
    expect(presentation).not.toContain(JSON.stringify(assessment));
    expect(presentation).not.toMatch(/"(?:discovery|evidenceSources|candidateId|assessmentId|version)":/);
    expect(presentation.length).toBeLessThan(4_000);
    expect(presentation).toContain("Limits:");
    expect(presentation).toContain("Next:");
    if (scenario === "acknowledgement-unknown") {
      expect(presentation).toContain("save could not be confirmed; it may have succeeded.");
      expect(presentation).toContain(assessment.history && "reason" in assessment.history ? assessment.history.reason : "missing reason");
    }
    if (scenario === "save-failed") expect(presentation).toContain("assessment was not saved.");
    if (assessment.status === "completed") {
      expect(outcome.captured).toBeDefined();
      expect(assessment.discovery?.candidates[0]?.outcome).toBe("Review manifest");
      const rendered = onTurnText.mock.calls.map(([text]) => text).join("\n");
      expect(rendered.match(/1\. Review manifest/g)).toHaveLength(1);
      expect(rendered).toContain("Uncertainty: Not verified");
      expect(rendered).toContain("Next: follow these manual steps — Review separately");
      if (scenario === "report-rendered") expect(presentation).not.toContain("1. Review manifest");
      else expect(presentation).toContain("1. Review manifest");
    }
    const expectedHistoryStatus = scenario === "setup" ? "setup-not-saved" : scenario.startsWith("legacy-") || scenario === "disabled" ? "disabled"
      : scenario === "acknowledgement-unknown" ? "acknowledgement-unknown"
      : ["revoked", "profile-replaced", "cancelled", "reset", "save-failed"].includes(scenario) || scenario.endsWith("-at-commit") ? "unsaved" : "saved";
    expect(assessment.history?.status).toBe(expectedHistoryStatus);
    expect(commitsAttempted).toBe(scenario.endsWith("-at-commit") || scenario === "acknowledgement-unknown" ? 1 : 0);
    if (scannerBytes) expect(await fs.readFile(path.join(cwd, PROGRAMMATIC_STATE_PATH))).toEqual(scannerBytes);
    expect(assessment.status).toBe(["cancelled", "reset"].includes(scenario) ? "cancelled" : scenario === "incomplete" ? "incomplete" : "completed");
    expect(assessment.deterministic.status).toBe(scenario === "setup" ? "not-run" : "succeeded");
    expect(presentation).toContain(scenario === "setup"
      ? "setup inspection only; no saved checks were run or settings changed."
      : "Checks: none of the 0 enabled checks applied. This is not a passing project check.");
    expect(scanCalls).toHaveBeenCalledTimes(scenario === "setup" ? 0 : 1);
    expect(profileCalls).toHaveBeenCalledTimes(scenario === "setup" ? 1 : 0);
    if (scenario === "setup") expect(profileCalls.mock.calls[0]![0]).toEqual({ action: "inspect" });
    expect(turns).toBe(scenario === "incomplete" ? 2 : 3);
    const stored = await readRecommendationHistory(cwd);
    if (scenario === "saved" || scenario === "report-rendered" || scenario === "incomplete" || scenario === "acknowledgement-unknown") {
      expect(stored.status).toBe("ready");
      if (stored.status !== "ready") throw new Error("Expected persisted history");
      expect(stored.history.assessments).toHaveLength(1);
      const saved = stored.history.assessments[0]!;
      if (assessment.history?.status !== "saved" && assessment.history?.status !== "acknowledgement-unknown") throw new Error("Expected saved or uncertain history acknowledgement");
      expect(saved.id).toBe(assessment.history.assessmentId);
      expect(Date.parse(saved.startedAt)).toBeGreaterThanOrEqual(startedBefore);
      expect(Date.parse(saved.startedAt)).toBeLessThanOrEqual(providerStarted);
      expect(saved.configurationSha256).toBe(proposal.configurationFingerprint.sha256);
      expect(saved.outcome).toBe(scenario === "incomplete" ? "incomplete" : "completed");
      expect(stored.history.observations).toHaveLength(scenario === "incomplete" ? 0 : 1);
      expect(JSON.stringify(stored.history)).not.toContain("receipt-");
      expect(JSON.stringify(stored.history)).not.toContain("history-fixture");
    } else expect(stored.status).toBe(scenario === "save-failed" ? "unavailable" : "missing");
    if (scenario !== "revoked" && scenario !== "profile-replaced") expect(await fs.readFile(profilePath)).toEqual(profileBefore);
  } finally { mounted.unmount(); restore(); await fs.rm(cwd, { recursive: true, force: true }); }
});

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
    const assessed = vi.spyOn(ProgrammaticAssessmentCoordinator.prototype, "run");
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
                      version: 2,
                      kind: "advisory",
                      coverage: {
                        status: "limited",
                        scope: "Fixture manifest",
                        reason: "Scripted assessment",
                      },
                      recommendations: [
                        {
                          version: 2,
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
                          workflow: {
                            trigger: "A manifest setting needs comparison", representativeCase: "Compare the fixture manifest setting",
                            inputs: ["package.json"], currentProcess: ["Read manifest", "Compare the setting manually"],
                            output: "Bounded comparison", successCheck: "Trace each comparison to inspected source",
                            affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read-only; edits need separate approval",
                            repeatability: { basis: "inferred", explanation: "Manifest changes may need repeated comparison; no measured frequency" },
                          },
                          alternatives: [{ kind: "manual", reasonNotSelected: "Repeated comparison benefits from the existing review procedure" }],
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
      // Assessment failures settle as bounded outcomes, not raw provider errors.
      expect(displayError).not.toHaveBeenCalled();
      const notice = messages.current.find((message) =>
        message.role === "assistant" && typeof message.content === "string" &&
        message.content.startsWith("## Needs assessment\n\n"));
      expect(notice).toBeDefined();
      expect(assessed).toHaveBeenCalledOnce();
      const outcome = await assessed.mock.results[0]!.value as ProgrammaticAssessmentOutcome;
      const { assessment } = outcome;
      expect(String(notice!.content)).not.toContain(JSON.stringify(assessment));
      expect(String(notice!.content)).not.toMatch(/"(?:discovery|evidenceSources|candidateId|assessmentId|version)":/);
      expect(String(notice!.content)).toContain(ending === "plan"
        ? "Saved checks failed. No retry was attempted."
        : "Checks: saved check run finished; 1 of 1 enabled checks applied. This is not a complete project check.");
      expect(assessment.status).toBe(["abort", "reset", "disposal"].includes(ending)
        ? "cancelled" : ["result", "plan"].includes(ending) ? "completed" : "incomplete");
      expect(assessment.deterministic).toMatchObject({ status: ending === "plan" ? "failed" : "succeeded" });
      expect(String(notice!.content)).not.toContain("terminal fixture failure");
      const results = messages.current.flatMap((message) =>
        message.role === "tool" ? message.content : [],
      );
      expect(scanExecute).toHaveBeenCalledOnce();
      if (ending !== "reset") {
        const firstScan = results.find((item) => item.toolCallId === "first-scan")!;
        // The host has already consumed the sole scan before the provider runs.
        expect(firstScan.isError).toBe(true);
        expect(String(firstScan.content)).toContain("one unchanged");
        const prompt = messages.current.find((message) => message.role === "user" &&
          typeof message.content === "string" && message.content.includes("Host-owned exact facts"));
        const scanResult = JSON.parse(String(prompt!.content).split(
          "Host-owned exact facts (not model authority; already collected, do not repeat):\n",
        )[1]!.split("\nReusable host evidence receipts:")[0]!).scanFacts;
        expect(scanResult.ok).toBe(ending !== "plan");
        if (ending === "plan") expect(scanResult.error.code).toBe("plan-mode-read-only");
        // The identical second call in the same response is cancelled by the agent loop.
        expect(
          String(results.find((item) => item.toolCallId === "second-scan")?.content),
        ).toContain("identical call already appeared in this response");
      }
      if (ending === "result" || ending === "plan") {
        expect(String(results.find((item) => item.toolCallId === "result")?.content)).toContain(
          "/compare: prompt available, not started. This does not guarantee the required tools or behavior.",
        );
        for (const name of blockedNames)
          expect(results.find((item) => item.toolCallId === `denied-${name}`)?.isError).toBe(true);
        expect(String(results.find((item) => item.toolCallId === "indexing")?.content)).toContain(
          "Corpus mutation is unavailable",
        );
      } else {
        expect(assessment.status).not.toBe("completed");
        expect(assessment.summary).toBe(assessment.status === "cancelled"
          ? "Assessment cancelled. Any saved check results and settings are unchanged by cancellation."
          : "Assessment did not finish. Saved check results and settings are separate from these suggestions.");
        expect(String(notice!.content)).toContain(assessment.summary);
        expect(String(notice!.content)).toContain("No retry or recommended work was started");
      }
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
