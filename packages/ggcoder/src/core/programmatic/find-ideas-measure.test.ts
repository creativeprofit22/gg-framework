import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../agent-session.js";
import { AuthStorage } from "../auth-storage.js";
import { createProgrammaticReadinessReader } from "../command-discovery.js";
import { useFakeHome } from "../../test-support/fake-home.js";
import {
  automatedBodies,
  automatedFiles,
} from "../../test-support/programmatic-evaluation-fixtures.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./profile.js";
import { ProgrammaticAdvisoryTurn } from "./advisory.js";

// Opt-in measurement of one scripted-provider Find ideas run; skipped in normal test runs.
// Only the provider stream is scripted. Live-model timing is out of scope here.
const enabled = process.env.GG_FIND_IDEAS_MEASURE === "1";
const label = process.env.GG_FIND_IDEAS_MEASURE_LABEL ?? "baseline";
const started = Date.now();
const progress = (stage: string) =>
  process.stderr.write(`[find-ideas-measure] ${stage} at ${Date.now() - started} ms\n`);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const INTERNAL_TERMS =
  /receipt|deterministic scan|budget-limited|programmatic_|command_information/i;

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

let home: string;
let restore: () => void;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "find-ideas-home-"));
  restore = useFakeHome(home);
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({
    accessToken: "fixture-not-a-real-credential",
    refreshToken: "",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  vi.mocked(stream).mockReset();
});
afterEach(async () => {
  restore();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

const receiptOf = (content: string) =>
  JSON.parse(
    content
      .split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]!
      .split("\n")[0]!,
  ) as { id: string; status: string };

function contextOf(prompt: string): {
  evidence?: { paths: { path: string; coverage: string }[]; excerpts: { path: string }[] };
} {
  const separator = prompt.lastIndexOf("\n\n## Untrusted advisory context\n\n");
  return JSON.parse(prompt.slice(prompt.indexOf("\n\n{", separator) + 2));
}

async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries)
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      out[path.relative(dir, file)] = createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
    }
  return out;
}

async function measure(
  cwd: string,
  sessionOptions: Partial<ConstructorParameters<typeof AgentSession>[0]>,
) {
  const submissions = vi.spyOn(ProgrammaticAdvisoryTurn.prototype, "submit");
  let turns = 0;
  let toolCalls = 0;
  let rejected = 0;
  let promptBytes = 0;
  const resultBytes = new Map<string, number>();
  let sample: string[] = [];
  let excerpts: string[] = [];
  const state: {
    reads: string[];
    leadId?: string;
    readIds: Record<string, string>;
    items?: Record<string, unknown>[];
  } = {
    reads: [],
    readIds: {},
  };
  vi.mocked(stream).mockImplementation(
    (params) =>
      new StreamResult(
        (async function* () {
          turns++;
          const results = params.messages.flatMap((message) =>
            message.role === "tool" ? message.content : [],
          );
          for (const result of results)
            resultBytes.set(result.toolCallId, Buffer.byteLength(String(result.content)));
          const prompt = params.messages.find(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("Host-owned exact facts"),
          );
          let calls: ToolCall[] = [];
          if (turns === 1 && prompt) {
            promptBytes = Buffer.byteLength(String(prompt.content));
            const evidence = contextOf(String(prompt.content)).evidence;
            sample = (evidence?.paths ?? []).map((item) => item.path);
            excerpts = (evidence?.excerpts ?? []).map((item) => item.path);
            state.reads = (excerpts.length >= 2 ? excerpts : sample).slice(0, 2);
            calls = [
              { type: "tool_call", id: "lead", name: "ls", args: { path: "." } },
              ...state.reads.map((file, index): ToolCall => ({
                type: "tool_call",
                id: `read-${index}`,
                name: "read",
                args: { file_path: file },
              })),
            ];
          } else if (prompt && state.reads.length === 2) {
            const output = (id: string) =>
              String(results.find((result) => result.toolCallId === id)?.content ?? "");
            if (!state.items) {
              state.leadId = receiptOf(output("lead")).id;
              state.readIds = {
                0: receiptOf(output("read-0")).id,
                1: receiptOf(output("read-1")).id,
              };
              const item = (source: string, file: string) => ({
                basis: "observed",
                source,
                code: "workflow-source",
                severity: "info",
                message: `Read ${file}`,
                location: { path: file },
              });
              // Two simultaneous rule failures: a lead used as observed, and a location the receipt didn't read.
              state.items = [
                item(state.leadId, state.reads[0]!),
                item(state.readIds[0]!, state.reads[1]!),
              ];
            } else {
              const last = [...results]
                .reverse()
                .find((result) => result.toolCallId.startsWith("submit-"));
              if (!last?.isError)
                return {
                  message: { role: "assistant", content: "Done." },
                  stopReason: "end_turn",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              rejected++;
              const text = String(last.content);
              let fixed = false;
              if (
                text.includes("Search leads and failed calls cannot substantiate observed evidence")
              ) {
                state.items[0]!.source = state.readIds[0]!;
                fixed = true;
              }
              if (text.includes("Evidence location was not inspected")) {
                state.items[1]!.source = state.readIds[1]!;
                fixed = true;
              }
              if (!fixed || rejected > 6)
                return {
                  message: { role: "assistant", content: `Stopped: ${text.slice(0, 200)}` },
                  stopReason: "end_turn",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
            }
            calls = [
              {
                type: "tool_call",
                id: `submit-${turns}`,
                name: "programmatic_advisory_result",
                args: {
                  version: 2,
                  kind: "advisory",
                  coverage: {
                    status: "limited",
                    scope: "Deterministic scan plus two receipts",
                    reason:
                      "Budget-limited: deterministic scan only; receipts from command_information were not reopened.",
                  },
                  recommendations: [
                    {
                      version: 2,
                      kind: "advisory",
                      outcome: "Keep reviewing the sampled files by hand",
                      rationale: "A scripted measurement idea; no recurrence is claimed.",
                      alternatives: [],
                      choice: {
                        kind: "manual",
                        steps: ["Review the sampled files when they change"],
                      },
                      evidence: { version: 1, items: state.items },
                      uncertainty: "Scripted measurement, not a real assessment",
                      workflow: {
                        trigger: "A sampled file changes",
                        representativeCase: "Review one sampled file",
                        inputs: state.reads,
                        currentProcess: ["Read the files"],
                        output: "A short review",
                        successCheck: "Each note traces to a read file",
                        affectedSubproject: { scope: "repository-wide" },
                        mutationBoundary: "Inspection only",
                        repeatability: { basis: "inferred", explanation: "Files change over time" },
                      },
                    },
                  ],
                },
              },
            ];
          }
          if (!calls.length)
            return {
              message: { role: "assistant", content: "Nothing to do." },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          toolCalls += calls.length;
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
  const session = new AgentSession({
    cwd,
    provider: "anthropic",
    model: "claude-sonnet-5",
    transient: true,
    systemPrompt: "Find ideas measurement fixture",
    mcpEnabled: false,
    approveToolExecution: async () => true,
    ...sessionOptions,
  });
  try {
    await session.initialize();
    const started = performance.now();
    await session.prompt("/programmatic");
    const wallMs = Math.round(performance.now() - started);
    const messages = session.getMessages();
    const accepted = messages
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .find((result) => result.toolCallId.startsWith("submit-") && !result.isError);
    const turn = submissions.mock.contexts.at(-1) as ProgrammaticAdvisoryTurn | undefined;
    const assistantTexts = messages.flatMap((message) =>
      message.role === "assistant" && typeof message.content === "string" ? [message.content] : [],
    );
    const shown = assistantTexts.filter((text) => text.includes("## What AI found")).join("\n");
    const lastResult = [...resultBytes.keys()].length;
    return {
      status: accepted ? "accepted" : "not-accepted",
      wallMs,
      modelTurns: turns,
      toolCalls,
      rejectedSubmissions: rejected,
      deliveredContextBytes:
        promptBytes + [...resultBytes.values()].reduce((sum, bytes) => sum + bytes, 0),
      promptBytes,
      toolResults: lastResult,
      sampledPaths: sample.length,
      excerptPaths: excerpts,
      firstSampledPaths: sample.slice(0, 15),
      limitations: turn ? [...turn.limitations] : [],
      catalogChangedLate: turn
        ? [...turn.limitations].some((line) =>
            line.startsWith("Your commands changed before AI finished"),
          )
        : false,
      chatReportChars: shown.length,
      fullReportInToolResult: !!accepted && String(accepted.content).includes("## What AI found"),
      fullReportInAssistantMessage: !!accepted && assistantTexts.includes(String(accepted.content)),
      internalTermsInChat: INTERNAL_TERMS.test(shown),
    };
  } finally {
    await session.dispose();
  }
}

it.skipIf(!enabled)(
  "measures one scripted Find ideas run on the fixture and on this repository",
  async () => {
    const report: Record<string, unknown> = {
      label,
      recordedAt: new Date().toISOString(),
      liveModel: "unmeasured: needs separate cost/access approval",
    };

    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "find-ideas-fixture-"));
    try {
      await fs.mkdir(path.join(fixture, "operations"));
      await fs.mkdir(path.join(fixture, ".gg/commands"), { recursive: true });
      for (const [file, text] of Object.entries(automatedFiles))
        await fs.writeFile(path.join(fixture, file), text);
      for (const [name, body] of Object.entries(automatedBodies))
        await fs.writeFile(
          path.join(fixture, `.gg/commands/${name}.md`),
          `---\nname: ${name}\n---\n${body}`,
        );
      const proposal = await buildProgrammaticProfileProposal(fixture);
      expect(
        (
          await persistProgrammaticProfile(
            fixture,
            proposal.configurationFingerprint,
            proposal.profile,
          )
        ).ok,
      ).toBe(true);
      report.fixture = await measure(fixture, {});
      progress("fixture");
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }

    // Read-only against this checkout: no scan tool, transient session, fake home.
    const readiness = await createProgrammaticReadinessReader(repoRoot)();
    progress(`repository readiness ${readiness}`);
    const before = await hashTree(path.join(repoRoot, ".gg/programmatic"));
    if (readiness !== "current")
      report.repository = {
        status: "blocked",
        reason: `Setup readiness is ${readiness}; not forced.`,
      };
    else
      report.repository = await measure(repoRoot, {
        allowedTools: [
          "read",
          "ls",
          "find",
          "grep",
          "command_information",
          "programmatic_advisory_result",
        ],
      });
    expect(await hashTree(path.join(repoRoot, ".gg/programmatic"))).toEqual(before);

    // Same repository layout via a temporary copy of HEAD; setup is saved only in the copy.
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), "find-ideas-repo-"));
    try {
      const archive = execFileSync("git", ["-C", repoRoot, "archive", "--format=tar", "HEAD"], {
        maxBuffer: 1 << 30,
      });
      execFileSync("tar", ["-xf", "-"], { cwd: copy, input: archive });
      await fs.rm(path.join(copy, ".gg/programmatic"), { recursive: true, force: true });
      const proposal = await buildProgrammaticProfileProposal(copy);
      expect(
        (
          await persistProgrammaticProfile(
            copy,
            proposal.configurationFingerprint,
            proposal.profile,
          )
        ).ok,
      ).toBe(true);
      progress("copy profile saved");
      const copyReadiness = await createProgrammaticReadinessReader(copy)();
      report.repositoryCopy =
        copyReadiness === "current"
          ? await measure(copy, {
              allowedTools: [
                "read",
                "ls",
                "find",
                "grep",
                "command_information",
                "programmatic_advisory_result",
              ],
            })
          : { status: "blocked", reason: `Copy readiness is ${copyReadiness}.` };
    } finally {
      await fs.rm(copy, { recursive: true, force: true });
    }

    progress("repository copy");
    const out = path.join(repoRoot, ".gg/verification", `find-ideas-measure-${label}.json`);
    await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  },
  300_000,
);
