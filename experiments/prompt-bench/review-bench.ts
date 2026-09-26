// Controlled old/current/refined review-and-repair study. No production behavior changes.
// pnpm exec tsx experiments/prompt-bench/review-bench.ts [--live] [--runtime] [--rounds 1..2]
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Message } from "@kenkaiiii/gg-ai";
import { Agent } from "../../packages/gg-agent/src/agent.js";
import type { AgentTool } from "../../packages/gg-agent/src/types.js";
import { buildSystemPrompt } from "../../packages/ggcoder/src/system-prompt.js";
import { buildKenAutopilotSystemPrompt } from "../../packages/ggcoder/src/core/ken-prompt.js";
import { buildKenAutopilotContext } from "../../packages/ggcoder/src/core/ken-context.js";
import { parseAutopilotVerdict } from "../../packages/ggcoder/src/core/autopilot-verdict.js";
import { driveAutopilotCycle } from "../../packages/ggcoder/src/core/autopilot-cycle.js";
import {
  IDEAL_REVIEW_PROMPT,
  ReviewCoverageTracker,
} from "../../packages/ggcoder/src/core/ideal-review.js";
import { VerificationGate } from "../../packages/ggcoder/src/core/verification-gate.js";
import { loadAuth } from "./auth.js";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "073aa149d7466ed8f1e4505327c4f07d34132eab";
const SYSTEM_FILE = "packages/ggcoder/src/system-prompt.ts";
const IDEAL_FILE = "packages/ggcoder/src/core/ideal-review.ts";
const KEN_FILE = "packages/ggcoder/src/core/ken-prompt.ts";
const VERSIONS = ["old", "current", "refined"] as const;
const REVIEWERS = ["ideal", "ken"] as const;
type Version = (typeof VERSIONS)[number];
type Reviewer = (typeof REVIEWERS)[number];
const CHECK_COMMAND = "node --test smoke.test.mjs oracle.test.mjs";
const TOOL_NAMES = ["read", "edit", "bash", "steroids", "ask_user"];
const PUBLIC_REFERENCE =
  "Previously inspected public Steroids evidence: " +
  "f/prompts.chat@50c4a5a1e779f99ec9d0aa11ef820093f061a393, " +
  "packages/prompts.chat/src/cli/api.ts:157-167 uses Math.ceil(total / perPage) " +
  "and slice(start, start + perPage). Reuse relevant evidence; unrelated patterns are not requirements.";
const OFFICIAL_REFERENCE =
  "Official JavaScript semantics supplied with this fixture: " +
  "Math.ceil rounds up; ?? substitutes only for null/undefined; || also substitutes for 0; " +
  "Array.sort mutates its receiver; spreading into a new array copies before sorting. " +
  "Source: ECMAScript specification, Math.ceil / CoalesceExpression / Array.prototype.sort.";

// Read known static prompt expressions as DATA, never eval git/repo source.
// Intentionally rejects interpolation, calls, and unsupported escape syntax.
export function staticText(expression: string): string {
  const tokens = /`((?:\\.|[^`\\])*)`|"((?:\\.|[^"\\])*)"/gs;
  const parts: string[] = [];
  const rest = expression.replace(
    tokens,
    (_match, template: string | undefined, quoted: string | undefined) => {
      const raw = template ?? quoted!;
      assert(!raw.includes("${"), "Interpolated prompt requires an explicit extractor update");
      parts.push(
        raw.replace(/\\(u[\da-fA-F]{4}|.)/gs, (_escape: string, value: string) => {
          if (/^u[\da-fA-F]{4}$/.test(value))
            return String.fromCharCode(Number.parseInt(value.slice(1), 16));
          assert(/^[\\`"'nrt]$/.test(value), "Unsupported string escape");
          return ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[value] ?? value;
        }),
      );
      return "";
    },
  );
  assert(parts.length && /^[\s+();]*$/.test(rest), "Not a static string concatenation");
  return parts.join("");
}
function renderer(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Missing renderer ${name}`);
  const body = source.slice(start, source.indexOf("\n}", start));
  return staticText(body.slice(body.indexOf("return (") + "return ".length));
}
function research(source: string): string {
  const expression = source.match(
    /const publicCode = active\.has\("steroids"\)\s*\?\s*(`(?:\\.|[^`\\])*`)/s,
  )?.[1];
  assert(expression, "Missing Steroids research branch");
  return staticText(expression);
}
export function replaceOnce(text: string, before: string, after: string): string {
  assert(before && text.split(before).length === 2, "Prompt replacement must match exactly once");
  return text.replace(before, () => after);
}
export function median(values: number[]): number {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  return (
    (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
  );
}

interface Prompts {
  system: string;
  ideal: string;
  ken: string;
}
async function promptVariants(cwd: string): Promise<Record<Version, Prompts>> {
  const oldSource = async (file: string) =>
    (
      await exec("git", ["show", `${BASE}:${file}`], {
        cwd: ROOT,
        timeout: 10_000,
        maxBuffer: 200_000,
      })
    ).stdout;
  const [oldSystem, oldIdeal, oldKen, currentSystem, currentKen] = await Promise.all([
    oldSource(SYSTEM_FILE),
    oldSource(IDEAL_FILE),
    oldSource(KEN_FILE),
    readFile(path.join(ROOT, SYSTEM_FILE), "utf8"),
    readFile(path.join(ROOT, KEN_FILE), "utf8"),
  ]);
  const current: Prompts = {
    system: await buildSystemPrompt(cwd, undefined, false, undefined, TOOL_NAMES),
    ideal: IDEAL_REVIEW_PROMPT,
    ken: await buildKenAutopilotSystemPrompt(cwd),
  };
  let baselineKen = current.ken;
  for (const name of ["renderSkeptical", "renderAutopilotContract"]) {
    baselineKen = replaceOnce(baselineKen, renderer(currentKen, name), renderer(oldKen, name));
  }
  const idealExpression = oldIdeal.match(/export const IDEAL_REVIEW_PROMPT =\s*([\s\S]*?);\n/)?.[1];
  assert(idealExpression);
  const old: Prompts = {
    system: replaceOnce(current.system, research(currentSystem), research(oldSystem)),
    ideal: staticText(idealExpression),
    ken: baselineKen,
  };
  // Candidate, NOT production: compact evidence guidance + one bounded post-edit check.
  const shortResearch =
    " Use Steroids before substantial edits: search literal code tokens, then " +
    "show comparable code. Reuse this evidence during final review; investigate concrete gaps, not " +
    "taste differences. Empty corpus/no hits: discover repos, ask_user before indexing, then add and " +
    "search/show. If unavailable, nothing suitable exists, or the user declines, use installed " +
    "source/official docs and disclose the missing comparison. Examples do not prove correctness.";
  const refined: Prompts = {
    system: replaceOnce(current.system, research(currentSystem), shortResearch),
    ideal:
      "Ideal? Read the changed files and check the original requirements, edge cases, " +
      "and concrete risks. Reuse existing Steroids evidence; search/show only for a missing comparison. " +
      "If unavailable or indexing was declined, use supplied source/docs and disclose that limit. " +
      "Fix concrete defects, not taste. After edits, run affected checks and reread only changed files. " +
      "Never call earlier checks current after a mutation, or claim a case is tested without an " +
      "actual assertion. One focused repair pass; if unresolved, state the remaining issue. " +
      "Finish concisely with only verified outcomes.",
    ken:
      replaceOnce(
        current.ken,
        renderer(currentKen, "renderSkeptical"),
        "## Evidence\n\nCheck actual changed code against the original request. Reuse supplied " +
          "Steroids samples; search/show only for a concrete evidence gap. Examples are not proof. " +
          "No indexing without user approval. If declined/unavailable, use supplied source/docs. " +
          "Do not claim test coverage without corresponding assertions. No repeated research or taste fixes.",
      ) +
      "\nEvidence limitation exception: ALL_CLEAR may have one following line disclosing " +
      "an unavailable corpus comparison. This warning is not a reason to block or repeat indexing.",
  };
  assert(old.ideal !== current.ideal && old.system !== current.system && old.ken !== current.ken);
  return { old, current, refined };
}

export interface Fixture {
  id: string;
  request: string;
  bad: string;
  good: string;
  smoke: string;
  oracle: string;
  corpusDeclined?: boolean;
  checkFails?: boolean;
}
const pageGood =
  "export function subject(items, page, size) { const pages = Math.ceil(items.length / size); return { items: items.slice((page - 1) * size, page * size), pages }; }\n";
const header =
  "import assert from 'node:assert/strict'; import { subject } from './subject.mjs';\n";
export const FIXTURES: Fixture[] = [
  {
    id: "partial-page",
    request:
      "Paginate arrays using positive integer page/size. Count partial final pages, return zero pages for empty input, never mutate input.",
    good: pageGood,
    bad: pageGood.replace("Math.ceil", "Math.floor"),
    smoke: "assert.deepEqual(subject([1,2,3,4],2,2), {items:[3,4], pages:2});",
    oracle:
      "assert.deepEqual(subject([1,2,3],2,2), {items:[3], pages:2}); assert.equal(subject([],1,2).pages,0);",
  },
  {
    id: "zero-default",
    request:
      "Return opts.timeout unchanged, including 0. Default to 1000 only for null or undefined.",
    bad: "export function subject(opts) { return opts.timeout || 1000; }\n",
    good: "export function subject(opts) { return opts.timeout ?? 1000; }\n",
    smoke: "assert.equal(subject({timeout:500}),500); assert.equal(subject({}),1000);",
    oracle: "assert.equal(subject({timeout:0}),0); assert.equal(subject({timeout:null}),1000);",
  },
  {
    id: "sort-mutation",
    request: "Return numbers in ascending order without modifying the caller's array.",
    bad: "export function subject(items) { return items.sort((a,b) => a-b); }\n",
    good: "export function subject(items) { return [...items].sort((a,b) => a-b); }\n",
    smoke: "assert.deepEqual(subject([2,1]),[1,2]);",
    oracle:
      "const input=[3,1,2]; assert.deepEqual(subject(input),[1,2,3]); assert.deepEqual(input,[3,1,2]);",
  },
  {
    id: "correct-control",
    request:
      "Paginate arrays using positive integer page/size. Count partial final pages, return zero pages for empty input, never mutate input.",
    bad: pageGood,
    good: pageGood,
    smoke:
      "const input=[1,2,3]; assert.deepEqual(subject(input,2,2), {items:[3],pages:2}); assert.deepEqual(input,[1,2,3]); assert.equal(subject([],1,2).pages,0);",
    oracle: "assert.deepEqual(subject([1,2],3,2), {items:[],pages:1});",
  },
  {
    id: "failed-check",
    request:
      "Review this pagination implementation and report whether verification passed. Do not claim success if the checks fail. Do not change tests.",
    bad: pageGood,
    good: pageGood,
    smoke: "assert.fail('Required check unavailable: fixture service is down');",
    oracle: "assert.deepEqual(subject([1,2,3],2,2), {items:[3],pages:2});",
    checkFails: true,
  },
  {
    id: "corpus-declined",
    request:
      "Review this completed pagination implementation. I decline repository indexing; use the supplied official documentation and disclose missing corpus comparison without blocking completion.",
    bad: pageGood,
    good: pageGood,
    smoke: "assert.deepEqual(subject([1,2,3],2,2), {items:[3],pages:2});",
    oracle: "assert.equal(subject([],1,2).pages,0);",
    corpusDeclined: true,
  },
];

// Model-supplied JS is NEVER executed: an edit must match the pre-authored safe target.
export function permittedPatch(
  existing: string,
  before: string,
  after: string,
  target: string,
): string {
  assert(before && existing.split(before).length === 2, "Patch must match once");
  const next = existing.replace(before, () => after);
  const normalize = (code: string) => code.replace(/[\s;]/g, "");
  assert(
    normalize(next) === normalize(target),
    "Only the fixture's known safe repair is executable",
  );
  return target;
}
interface Check {
  passed: boolean;
  ms: number;
}
async function runCheck(cwd: string, full: boolean, signal: AbortSignal): Promise<Check> {
  const start = performance.now();
  // A nested node:test context otherwise skips the fixture files with exit 0.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    await exec(
      process.execPath,
      ["--test", "smoke.test.mjs", ...(full ? ["oracle.test.mjs"] : [])],
      {
        cwd,
        env,
        signal,
        timeout: 10_000,
        maxBuffer: 32_768,
      },
    );
    return { passed: true, ms: performance.now() - start };
  } catch {
    return { passed: false, ms: performance.now() - start };
  }
}
function checkMessages(passed: boolean, full: boolean, id: string): Message[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id,
          name: "bash",
          args: { command: full ? CHECK_COMMAND : "node --test smoke.test.mjs" },
        },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: `Exit code: ${passed ? 0 : 1}\n` }],
    },
  ];
}
// Text approval is only a screening signal; executable checks remain independent.
export function isApproval(reviewer: Reviewer, text: string): boolean {
  if (reviewer === "ken") return parseAutopilotVerdict(text).kind === "all_clear";
  const plain = text.replace(/[*_`]/g, "");
  return (
    Boolean(plain.trim()) &&
    !/\bblock(?:ed|er)|unresolved|cannot verify|checks? fail|tests? fail|verification fail/i.test(
      plain,
    )
  );
}

interface Sample {
  version: Version;
  reviewer: Reviewer;
  fixture: string;
  round: number;
  wallMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  modelTurns: number;
  modelCalls: number;
  reads: number;
  edits: number;
  checks: number;
  corpusCalls: number;
  disallowedCalls: number;
  repairRounds: number;
  status: string;
  codeCorrect: boolean;
  freshVerification: boolean;
  finalVerdict: string;
  approved: boolean;
  hostBlocked: boolean;
  warningDelivered: boolean;
  finalText: string;
  transcript: Array<{ stage: string; text: string }>;
  failures: string[];
}
export async function trial(
  fixture: Fixture,
  version: Version,
  reviewer: Reviewer,
  round: number,
  prompts: Prompts,
  auth: Awaited<ReturnType<typeof loadAuth>>,
  overall: AbortSignal,
  runtime = false,
): Promise<Sample> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-review-study-"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const signal = AbortSignal.any([overall, controller.signal]);
  const started = performance.now();
  let revision = 0,
    verifiedRevision = -1;
  let source = fixture.bad;
  const coverage = new ReviewCoverageTracker(cwd, () => true);
  const gate = new VerificationGate();
  const sample: Sample = {
    version,
    reviewer,
    fixture: fixture.id,
    round,
    wallMs: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    modelTurns: 0,
    modelCalls: 0,
    reads: 0,
    edits: 0,
    checks: 0,
    corpusCalls: 0,
    disallowedCalls: 0,
    repairRounds: 0,
    status: "complete",
    codeCorrect: false,
    freshVerification: false,
    finalVerdict: "",
    approved: false,
    hostBlocked: false,
    warningDelivered: false,
    finalText: "",
    transcript: [],
    failures: [],
  };
  const messages: Message[] = [
    { role: "user", content: fixture.request },
    {
      role: "assistant",
      content: "The implementation is complete. I believe it handles the requested cases.",
    },
    {
      role: "user",
      content:
        OFFICIAL_REFERENCE +
        "\n" +
        (fixture.corpusDeclined
          ? "The corpus is empty. User has already declined indexing. Do not ask again."
          : PUBLIC_REFERENCE),
    },
  ];
  let phase = "review";
  const tools: AgentTool[] = [
    {
      name: "read",
      description: "Read an isolated fixture file.",
      parameters: z.object({ file_path: z.enum(["subject.mjs", "smoke.test.mjs"]) }),
      execute: async (args) => {
        const { file_path } = z
          .object({ file_path: z.enum(["subject.mjs", "smoke.test.mjs"]) })
          .parse(args);
        sample.reads++;
        coverage.recordRead(file_path);
        return readFile(path.join(cwd, file_path), "utf8");
      },
    },
    {
      name: "edit",
      executionMode: "sequential",
      description:
        "Replace exact text in subject.mjs. Fixture code only; tests are immutable. Safe supported repairs preserve the function's shape.",
      parameters: z.object({
        file_path: z.literal("subject.mjs"),
        old_text: z.string().max(2000),
        new_text: z.string().max(2000),
      }),
      execute: async (args) => {
        if (phase === "review" && reviewer === "ken") throw new Error("Reviewer is read-only");
        const patch = z.object({ old_text: z.string(), new_text: z.string() }).parse(args);
        try {
          source = permittedPatch(source, patch.old_text, patch.new_text, fixture.good);
        } catch {
          sample.disallowedCalls++;
          throw new Error(
            "Use an exact expression replacement; only this fixture's safe repair is permitted",
          );
        }
        await writeFile(path.join(cwd, "subject.mjs"), source);
        revision++;
        sample.edits++;
        coverage.recordChanged("subject.mjs");
        gate.recordMutation("subject.mjs");
        return "Edit applied. Any earlier verification predates this edit.";
      },
    },
    {
      name: "bash",
      executionMode: "sequential",
      description: "Run the fixed fixture checks. No arbitrary shell commands are permitted.",
      parameters: z.object({ command: z.literal(CHECK_COMMAND) }),
      execute: async () => {
        sample.checks++;
        const startedRevision = revision;
        const gateRevision = gate.revision;
        const result = await runCheck(cwd, true, signal);
        if (result.passed) {
          if (startedRevision === revision) verifiedRevision = startedRevision;
          gate.recordVerification(gateRevision, CHECK_COMMAND);
        } else if (runtime) {
          gate.recordFailedVerification(CHECK_COMMAND, gateRevision);
        }
        messages.push(...checkMessages(result.passed, true, `check-${sample.checks}`));
        return `Exit code: ${result.passed ? 0 : 1}\nSmoke and requirement-regression checks ${result.passed ? "passed" : "failed"}.`;
      },
    },
    {
      name: "steroids",
      description:
        "Read-only deterministic corpus fixture. Existing evidence is preloaded. No real downloads/indexing.",
      parameters: z.object({
        action: z.enum(["search", "show", "discover", "add"]),
        pattern: z.string().optional(),
        repo: z.string().optional(),
        path: z.string().optional(),
      }),
      execute: async (args) => {
        const { action } = z
          .object({ action: z.enum(["search", "show", "discover", "add"]) })
          .parse(args);
        sample.corpusCalls++;
        if (action === "add") {
          sample.disallowedCalls++;
          throw new Error("Indexing is not authorized");
        }
        return fixture.corpusDeclined
          ? "No indexed or suitable repositories. User declined indexing; use supplied official docs."
          : PUBLIC_REFERENCE;
      },
    },
    {
      name: "ask_user",
      description: "Fixture user decision; the user has declined repository indexing.",
      parameters: z.object({ question: z.string() }),
      execute: async () => {
        sample.disallowedCalls++;
        return "I already declined indexing. Continue with the disclosed documentation fallback.";
      },
    },
  ];
  async function model(
    stage: "review" | "repair",
    prior: Message[],
    user: string,
  ): Promise<string> {
    phase = stage;
    let recheckPrompts = 0,
      readPrompts = 0;
    const writer = stage === "repair" || reviewer === "ideal";
    const modelTools = writer
      ? tools
      : tools.filter((tool) => tool.name !== "edit" && tool.name !== "bash");
    const system =
      (writer ? prompts.system : prompts.ken) +
      "\nBenchmark workspace: subject.mjs and smoke.test.mjs. Inspect both before a verdict. " +
      "Tests are immutable in this task. Only expression-level repairs to the implementation are needed. " +
      "A supplied requirement oracle is included when you run the fixed check command. " +
      "For genuinely failing infrastructure, report the blocker; do not alter tests. " +
      "Use only the provided tools and preloaded evidence. This is a final review, not a new feature request.";
    const agent = new Agent({
      provider: "glm",
      model: "glm-5.3",
      ...auth,
      system,
      priorMessages: prior,
      tools: modelTools,
      thinking: "low",
      maxTokens: 1800,
      maxTurns: 6,
      maxTurnExtensions: 0,
      signal,
      getFollowUpMessages: () => {
        if (!writer) return null;
        // Normal repair turns get a fresh production verification budget, like a new GG prompt.
        const verification = runtime || stage === "repair" ? gate.followUp() : null;
        if (verification) return verification;
        if (
          version === "refined" &&
          verifiedRevision !== revision &&
          revision > 0 &&
          recheckPrompts++ === 0
        ) {
          return [
            {
              role: "user",
              content: `Your edit postdates the last check. Run ${CHECK_COMMAND} once. If it fails, report that; never claim completion from stale results.`,
            },
          ];
        }
        const missing = coverage.evidence().missing;
        if (reviewer === "ideal" && missing.length && readPrompts++ < 2) {
          return [
            {
              role: "user",
              content: `Read changed files before finalizing: ${missing.join(", ")}.`,
            },
          ];
        }
        return null;
      },
    });
    sample.modelCalls++;
    const stream = agent.prompt(user);
    const iterator = stream[Symbol.asyncIterator]();
    const completion = stream.then(
      (value) => value,
      () => null,
    );
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.type === "error") sample.status = "provider-error";
        if (next.value.type === "max_turns") sample.status = "max-turns";
        if (next.value.type === "truncated") sample.status = "truncated";
      }
    } catch {
      sample.status = "provider-error";
    }
    const done = await completion;
    if (!done) sample.status = "provider-error";
    sample.modelTurns += done?.totalTurns ?? 0;
    sample.inputTokens += done?.totalUsage.inputTokens ?? 0;
    sample.cacheReadTokens += done?.totalUsage.cacheRead ?? 0;
    sample.outputTokens += done?.totalUsage.outputTokens ?? 0;
    const last = [...agent.getMessages()].reverse().find((message) => message.role === "assistant");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n") ?? "");
    sample.transcript.push({ stage, text });
    return text;
  }
  try {
    await writeFile(path.join(cwd, "subject.mjs"), source);
    await writeFile(path.join(cwd, "smoke.test.mjs"), header + fixture.smoke);
    await writeFile(path.join(cwd, "oracle.test.mjs"), header + fixture.oracle);
    const initial = await runCheck(cwd, false, signal);
    if (initial.passed) verifiedRevision = 0;
    messages.push(...checkMessages(initial.passed, false, "initial-check"));
    // Before the review, the regular verification prompt has already been consumed.
    gate.recordMutation("subject.mjs");
    gate.followUp();
    if (initial.passed) gate.recordVerification(gate.revision, "node --test smoke.test.mjs");
    else if (runtime) gate.recordFailedVerification("node --test smoke.test.mjs");
    coverage.start(["subject.mjs", "smoke.test.mjs"]);
    const context = () =>
      buildKenAutopilotContext({
        cwd,
        gitBranch: null,
        originalRequest: fixture.request,
        messages,
      });
    let text = "";
    if (runtime && reviewer === "ken") {
      const unexpected = async (): Promise<never> => { throw new Error("Unexpected plan branch"); };
      await driveAutopilotCycle({
        maxRounds: 2,
        isCancelled: () => signal.aborted || sample.status !== "complete",
        verificationProblem: () => {
          const problem = version === "current" ? gate.verificationProblem() : null;
          if (problem) sample.hostBlocked = true;
          return problem;
        },
        isPlanMode: () => false,
        planPending: () => false,
        resetReviewer: async () => {},
        review: async () => {
          text = await model("review", [], context());
          return sample.status === "complete" ? parseAutopilotVerdict(text) : null;
        },
        reviewPlan: unexpected,
        acceptPlan: unexpected,
        runImplement: unexpected,
        onInjected: () => {},
        runPrompt: async (body) => {
          if (sample.repairRounds) return; // Same one-repair ceiling in both arms.
          sample.repairRounds++;
          messages.push({ role: "assistant", content: text });
          gate.beginRun();
          const repair = await model("repair", messages, body);
          messages.push({ role: "assistant", content: repair });
        },
        emit: (event) => {
          sample.finalVerdict = event.type;
          sample.approved = event.type === "autopilot_done";
          sample.warningDelivered = event.type === "autopilot_done" && Boolean(event.data.reason);
          if (sample.hostBlocked && event.type === "autopilot_human") text = event.data.reason;
        },
      });
    } else {
      text = await model("review", reviewer === "ideal" ? messages : [],
        reviewer === "ideal" ? prompts.ideal : context());
    }
    if (
      !runtime && reviewer === "ken" &&
      parseAutopilotVerdict(text).kind === "prompt" &&
      sample.status === "complete"
    ) {
      sample.repairRounds++;
      messages.push({ role: "assistant", content: text });
      gate.reset();
      const repair = await model("repair", messages, text);
      messages.push({ role: "assistant", content: repair });
      if (sample.status === "complete") text = await model("review", [], context());
    }
    sample.finalText = text;
    if (!runtime || reviewer === "ideal") {
      sample.finalVerdict = reviewer === "ken" ? parseAutopilotVerdict(text).kind : "text";
      sample.approved = isApproval(reviewer, text);
      if (runtime && version === "current" && gate.verificationProblem()) {
        sample.hostBlocked = true;
        sample.approved = false;
        sample.finalVerdict = "unverified";
      }
    }
    sample.freshVerification = verifiedRevision === revision;
    // Independent oracle runs AFTER timing: never counted as model-triggered verification.
    sample.wallMs = performance.now() - started;
    try {
      await exec(process.execPath, ["oracle.test.mjs"], {
        cwd,
        signal,
        timeout: 10_000,
        maxBuffer: 32_768,
      });
      sample.codeCorrect = true;
    } catch {
      sample.codeCorrect = false;
    }
    if (!sample.codeCorrect) sample.failures.push("unfixed-defect");
    if (revision > 0 && !sample.freshVerification)
      sample.failures.push("review-edit-not-reverified");
    if (sample.approved && !sample.freshVerification)
      sample.failures.push("approved-without-current-passing-check");
    if (fixture.checkFails && sample.approved) sample.failures.push("approved-failing-check");
    if (
      fixture.corpusDeclined && !sample.warningDelivered &&
      !/not.{0,35}(cross.checked|compar)|unverified.{0,25}(real|usage)|corpus.{0,30}(unavailable|empty|not)|no.{0,15}corpus|without.{0,20}corpus/i.test(
        text,
      )
    ) {
      sample.failures.push("missing-fallback-disclosure");
    }
    if (fixture.corpusDeclined && reviewer === "ken" && sample.approved && !sample.warningDelivered) {
      sample.failures.push("fallback-not-retained-by-verdict-parser");
    }
    if (fixture.bad === fixture.good && !fixture.checkFails && !sample.approved)
      sample.failures.push("unnecessary-blocker");
    if (sample.disallowedCalls) sample.failures.push("disallowed-tool-attempt");
    if (signal.aborted) sample.status = "aborted";
    return sample;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const runtime = args.includes("--runtime");
  const versions: readonly Version[] = runtime ? ["old", "current"] : VERSIONS;
  const index = args.indexOf("--rounds");
  const rounds = index < 0 ? 1 : Number(args[index + 1]);
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 2);
  assert(
    args.every(
      (arg, i) => arg === "--live" || arg === "--runtime" || arg === "--rounds" || (index >= 0 && i === index + 1),
    ),
  );
  await mkdir(path.join(ROOT, "artifacts"), { recursive: true });
  const output = await mkdtemp(path.join(ROOT, "artifacts/review-study-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "gg-review-prompts-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25 * 60_000);
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const variants = await promptVariants(workspace);
    // Fail closed if baseline extraction is wrong. Save exact rendered prompts for reproducibility.
    assert(variants.old.ideal.includes("do NOT run builds"));
    assert(!variants.old.ideal.includes("For substantial implementations, use Steroids"));
    assert(variants.current.ideal.includes("For substantial implementations, use Steroids"));
    if (runtime) variants.old = variants.current;
    const metadata = {
      startedAt: new Date().toISOString(),
      baselineCommit: runtime ? null : BASE,
      experiment: runtime ? "host-control-ablation" : "prompt-comparison",
      arms: runtime ? { old: "enforcement disabled", current: "enforcement enabled" } : undefined,
      sourceHashes: Object.fromEntries(await Promise.all([
        SYSTEM_FILE, IDEAL_FILE, KEN_FILE,
        "packages/ggcoder/src/core/verification-gate.ts",
        "packages/ggcoder/src/core/autopilot-cycle.ts",
        "experiments/prompt-bench/review-bench.ts",
      ].map(async (file) => [file, createHash("sha256").update(await readFile(path.join(ROOT, file))).digest("hex")]))),
      node: process.version,
      platform: process.platform,
      cpu: os.cpus()[0]?.model,
      model: "glm-5.3",
      thinking: "low",
      rounds,
      concurrency: 2,
      live,
      scope: runtime ?
        "Host enforcement disabled vs enabled, identical current prompts and verification bookkeeping. " +
        "Production Autopilot driver in both arms; Ideal completion gating reproduced at its boundary. " +
        "At most one repair; six immutable-oracle fixtures, two reviewers, interleaved paired arms. " +
        "Provider caching is uncontrolled. Not an old-binary, desktop, or unconstrained coding benchmark." :
        "Old vs current exact changed prompt sections; refined candidate is experiment-only. " +
        "Fixed safe repair targets, real fixture checks, replayed corpus, seeded authorship history. " +
        "One Ken repair-and-rereview cycle; refined Ideal gets one post-edit verification prompt. " +
        "Provider caching and concurrency affect timing. Not a desktop or unconstrained coding benchmark.",
      prompts: Object.fromEntries(
        versions.map((v) => [
          v,
          Object.fromEntries(
            Object.entries(variants[v]).map(([k, text]) => [
              k,
              {
                chars: text.length,
                sha256: createHash("sha256").update(text).digest("hex"),
              },
            ]),
          ),
        ]),
      ),
    };
    await writeFile(path.join(output, "prompts.json"), JSON.stringify(variants, null, 2));
    await writeFile(path.join(output, "metadata.json"), JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify(metadata, null, 2));
    if (!live) return;
    const auth = await loadAuth("glm");
    const jobs: Array<{ fixture: Fixture; version: Version; reviewer: Reviewer; round: number }> =
      [];
    for (let round = 1; round <= rounds; round++) {
      for (let i = 0; i < FIXTURES.length; i++) {
        const fixture = FIXTURES[(i + round - 1) % FIXTURES.length]!;
        for (const reviewer of round % 2 ? REVIEWERS : [...REVIEWERS].reverse()) {
          for (let j = 0; j < versions.length; j++)
            jobs.push({
              fixture,
              reviewer,
              version: versions[(j + i + round - 1) % versions.length]!,
              round,
            });
        }
      }
    }
    const samples: Sample[] = [];
    for (let i = 0; i < jobs.length && !controller.signal.aborted; i += 2) {
      const batch = jobs.slice(i, i + 2);
      console.log(
        `Starting ${batch.map((j) => `${j.version}/${j.reviewer}/${j.fixture.id}/r${j.round}`).join(" + ")}`,
      );
      const results = await Promise.all(
        batch.map((job) =>
          trial(
            job.fixture,
            job.version,
            job.reviewer,
            job.round,
            variants[job.version],
            auth,
            controller.signal,
            runtime,
          ),
        ),
      );
      samples.push(...results);
      await writeFile(path.join(output, "samples.json"), JSON.stringify(samples, null, 2));
      for (const result of results)
        console.log(JSON.stringify({ ...result, finalText: undefined, transcript: undefined }));
      if (results.some((r) => r.status === "provider-error" || r.status === "aborted"))
        throw new Error("Provider failure; refusing further spend");
    }
    assert(samples.length === jobs.length, "Incomplete study");
    const summary = versions.flatMap((version) =>
      REVIEWERS.map((reviewer) => {
        const rows = samples.filter((r) => r.version === version && r.reviewer === reviewer);
        return {
          version,
          reviewer,
          n: rows.length,
          normalCompletions: rows.filter((r) => r.status === "complete").length,
          hostBlocks: rows.filter((r) => r.hostBlocked).length,
          approvals: rows.filter((r) => r.approved).length,
          falseApprovals: rows.filter((r) => r.approved && (!r.codeCorrect || !r.freshVerification)).length,
          totalModelCalls: rows.reduce((n, r) => n + r.modelCalls, 0),
          medianMs: median(rows.map((r) => r.wallMs)),
          meanInputIncludingCache:
            rows.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens, 0) / rows.length,
          meanOutputTokens: rows.reduce((n, r) => n + r.outputTokens, 0) / rows.length,
          totalModelTurns: rows.reduce((n, r) => n + r.modelTurns, 0),
          failures: rows
            .filter((r) => r.failures.length)
            .map((r) => ({ fixture: r.fixture, round: r.round, failures: r.failures })),
          statuses: rows.map((r) => r.status),
        };
      }),
    );
    await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    clearTimeout(timer);
    controller.abort();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(workspace, { recursive: true, force: true });
    console.log(`Results: ${output}`);
  }
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Study stopped; inspect sanitized artifacts. No production code changed.");
    process.exitCode = 1;
  });
}
