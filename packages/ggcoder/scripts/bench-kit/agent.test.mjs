// Agent lane: transcripts, pass claims, test-result formats, task bundles,
// prices, the spend broker, the agent adapter and its four gates, end to end
// with a fake agent CLI (plan scenarios 5 and 6). Nothing touches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { main } from "../../assets/bench-kit/cli.mjs";
import {
  agentArgv,
  stderrSummary,
  validate as validateAgent,
} from "../../assets/bench-kit/lib/adapters/agent.mjs";
import { checkApproval, createBroker, planSpend } from "../../assets/bench-kit/lib/budget.mjs";
import {
  parseJsonResults,
  parseJunit,
  parseTap,
  statusOf,
} from "../../assets/bench-kit/lib/check-results.mjs";
import {
  estimateCost,
  knownCost,
  priceKey,
  validatePrices,
} from "../../assets/bench-kit/lib/cost.mjs";
import { gateValidators } from "../../assets/bench-kit/lib/gates/index.mjs";
import { metricValidators } from "../../assets/bench-kit/lib/metrics/index.mjs";
import { validateStudy } from "../../assets/bench-kit/lib/study.mjs";
import {
  diffSnapshots,
  globToRegExp,
  loadTask,
  matchesAny,
  validateTask,
} from "../../assets/bench-kit/lib/task.mjs";
import { claimsPass, parseTranscript } from "../../assets/bench-kit/lib/transcript.mjs";

const node = process.execPath;
const TASK_SAMPLE = fileURLToPath(
  new URL("../../assets/bench-kit/templates/task.sample", import.meta.url),
);
const quiet = { stderr: () => {} };
const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

// ---------------------------------------------------------------- units

describe("agent transcripts", () => {
  it("reads ggcoder --json: usage from agent_done, tool calls, the closing message", () => {
    const t = parseTranscript(
      lines(
        { type: "text_delta", text: "Looking. " },
        { type: "tool_call_start", toolCallId: "a", name: "bash", args: { command: "npm test" } },
        { type: "tool_call_end", toolCallId: "a", result: "boom", isError: true, durationMs: 4 },
        {
          type: "turn_end",
          turn: 1,
          stopReason: "tool_use",
          usage: { inputTokens: 5, outputTokens: 1 },
        },
        { type: "text_delta", text: "Done: " },
        { type: "text_delta", text: "fixed it." },
        {
          type: "agent_done",
          totalTurns: 2,
          totalUsage: { inputTokens: 100, outputTokens: 20, cacheRead: 7, cacheWrite: 3 },
        },
      ),
      "ggcoder-json",
    );
    assert.equal(t.terminal.kind, "done");
    assert.deepEqual(t.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
    assert.equal(t.turns, 2);
    assert.deepEqual(t.calls, [
      { id: "a", name: "bash", argsText: '{"command":"npm test"}', isError: true },
    ]);
    assert.equal(t.finalText, "Done: fixed it.");
    assert.equal(t.allText, "Looking. Done: fixed it.");
  });

  it("classifies ggcoder runs from terminal events only", () => {
    const failed = parseTranscript(
      lines({ type: "text_delta", text: "ok" }, { type: "error", message: "429 rate limited" }),
      "ggcoder-json",
    );
    assert.deepEqual(failed.terminal, { kind: "error", message: "429 rate limited" });
    const outOfTurns = parseTranscript(
      lines(
        { type: "max_turns", totalTurns: 5, maxTurns: 5 },
        { type: "agent_done", totalTurns: 5, totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ),
      "ggcoder-json",
    );
    assert.equal(outOfTurns.terminal.kind, "max_turns");
    // Text that mentions errors, and a wrongly named final event, never finish a run.
    const silent = parseTranscript(
      lines({ type: "text_delta", text: "error: all done" }, { type: "toolcall_done" }, "not json"),
      "ggcoder-json",
    );
    assert.equal(silent.terminal.kind, "none");
    assert.equal(silent.unparsed, 1);
  });

  it("reads claude stream-json: result usage, reported cost, tool errors, subtypes", () => {
    const t = parseTranscript(
      [
        lines(
          { type: "system", subtype: "init", model: "x" },
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "There is an error in add." },
                { type: "tool_use", id: "u1", name: "Bash", input: { command: "node --test" } },
              ],
            },
          },
          {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false }] },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 3,
            result: "Fixed it.",
            total_cost_usd: 0.25,
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 1,
            },
          },
        ),
      ].join("\n"),
      "claude-stream-json",
    );
    assert.equal(t.terminal.kind, "done", "assistant text saying 'error' does not classify");
    assert.equal(t.reportedCostUsd, 0.25);
    assert.deepEqual(t.usage, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
    });
    assert.equal(t.turns, 3);
    assert.equal(t.finalText, "Fixed it.");
    assert.equal(t.calls[0]?.isError, false);
    const maxed = parseTranscript(
      lines({ type: "result", subtype: "error_max_turns", is_error: true }),
      "claude-stream-json",
    );
    assert.equal(maxed.terminal.kind, "max_turns");
    const crashed = parseTranscript(
      lines({ type: "result", subtype: "error_during_execution", is_error: true }),
      "claude-stream-json",
    );
    assert.deepEqual(crashed.terminal, {
      kind: "error",
      subtype: "error_during_execution",
      message: "error_during_execution",
    });
    const apiError = parseTranscript(
      lines({ type: "error", error: { message: "overloaded" } }),
      "claude-stream-json",
    );
    assert.deepEqual(apiError.terminal, { kind: "error", message: "overloaded" });
  });

  it("plain text agents end by exit code", () => {
    assert.equal(parseTranscript("hi", "text", { exitCode: 0 }).terminal.kind, "done");
    assert.deepEqual(parseTranscript("hi", "text", { exitCode: 2 }).terminal, {
      kind: "error",
      message: "exited 2",
    });
  });
});

describe("pass claims are negation-aware", () => {
  const claims = (t) => claimsPass(t).claimed;
  it("matches the known cases", () => {
    assert.equal(claims("Tests passed."), true);
    assert.equal(claims("Tests passed. The runner is unavailable."), true);
    assert.equal(claims("All tests pass now."), true);
    assert.equal(claims("The test suite is green."), true);
    assert.equal(claims("I am not claiming tests passed."), false);
    assert.equal(claims("No tests passed because the runner is unavailable."), false);
    assert.equal(claims("I am not claiming tests passed. Checks passed."), true);
    assert.equal(claims("I couldn't confirm that the tests pass."), false);
    assert.equal(claims("Run it to see whether tests pass."), false);
    assert.equal(claims("The tests didn't pass."), false);
    assert.equal(claims("I changed add()."), false);
    assert.equal(claimsPass("Fixed it. All tests pass.").quote, "All tests pass");
  });
});

describe("test result formats", () => {
  // Real `node --test --test-reporter=tap` output (Node 22), trimmed.
  const TAP = [
    "TAP version 13",
    "# Subtest: add handles positive numbers",
    "ok 1 - add handles positive numbers",
    "  ---",
    "  duration_ms: 0.872",
    "  ...",
    "# Subtest: add handles a negative second number",
    "not ok 2 - add handles a negative second number",
    "  ---",
    "  error: |-",
    "    ok 99 - this line is inside YAML",
    "  ...",
    "# Subtest: suite \\# with hash",
    "    # Subtest: inner",
    "    ok 1 - inner",
    "    # Subtest: skipped one",
    "    ok 2 - skipped one # SKIP",
    "    1..2",
    "ok 3 - suite \\# with hash",
    "1..3",
  ].join("\n");

  it("parses TAP with nesting, escapes, skips and YAML blocks", () => {
    assert.deepEqual(parseTap(TAP), [
      { id: "add handles positive numbers", name: "add handles positive numbers", status: "pass" },
      {
        id: "add handles a negative second number",
        name: "add handles a negative second number",
        status: "fail",
      },
      { id: "suite # with hash > inner", name: "inner", status: "pass" },
      { id: "suite # with hash > skipped one", name: "skipped one", status: "skip" },
      { id: "suite # with hash", name: "suite # with hash", status: "pass" },
    ]);
  });

  it("parses JUnit with nested suites and entities", () => {
    const xml = `<?xml version="1.0"?><testsuites>
      <testcase name="a &amp; b" classname="test"/>
      <testsuite name="math"><testcase name="adds" classname="test"><failure message="x"/></testcase>
        <testcase name="later"><skipped/></testcase></testsuite>
    </testsuites>`;
    assert.deepEqual(parseJunit(xml), [
      { id: "a & b", name: "a & b", status: "pass" },
      { id: "math > adds", name: "adds", status: "fail" },
      { id: "math > later", name: "later", status: "skip" },
    ]);
  });

  it("parses JSON results and looks tests up by id, then name", () => {
    const r = parseJsonResults('log line\n{"tests":{"a":"passed","b":"FAILED","c":"todo"}}');
    assert.deepEqual(
      r.map((x) => x.status),
      ["pass", "fail", "skip"],
    );
    const results = [
      { id: "s1 > same", name: "same", status: "pass" },
      { id: "s2 > same", name: "same", status: "fail" },
    ];
    assert.equal(statusOf(results, "s1 > same"), "pass");
    assert.equal(statusOf(results, "same"), "fail", "every match of a bare name must pass");
    assert.equal(statusOf(results, "nope"), "missing");
  });
});

describe("task bundles", () => {
  it("validates task.json and loads the shipped sample", async () => {
    assert.deepEqual(validateTask({ schema: 1 }), []);
    const problems = validateTask({
      schema: 2,
      failToPass: ["a"],
      passToPass: ["a"],
      allowedPaths: ["../x"],
      testFormat: "xml",
      extra: 1,
    });
    assert.equal(problems.length, 5, problems.join("\n"));
    const sample = await loadTask(TASK_SAMPLE);
    assert.equal(sample.ok, true, sample.ok ? "" : sample.error.message);
    assert.ok(sample.value.oracleDir);
    assert.deepEqual(sample.value.task.canaries, ["config/keep.json"]);
  });

  it("matches globs over posix paths", () => {
    assert.equal(matchesAny("src/a/b.mjs", ["src/**"]), true);
    assert.equal(matchesAny("src/b.mjs", ["src"]), true);
    assert.equal(matchesAny("srcx/b.mjs", ["src"]), false);
    assert.equal(matchesAny("README.md", ["src/**"]), false);
    assert.equal(globToRegExp("*.md").test("docs/a.md"), false);
    assert.equal(globToRegExp("**/*.md").test("docs/a.md"), true);
    assert.equal(globToRegExp("**/*.md").test("a.md"), true);
    assert.deepEqual(diffSnapshots({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" }), {
      added: ["d"],
      modified: ["b"],
      deleted: ["c"],
    });
  });
});

describe("prices and cost", () => {
  const prices = {
    "fake/m": {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      source: "test",
      asOf: "2026-10-01",
    },
  };
  it("validates price tables and never guesses a price", () => {
    assert.deepEqual(validatePrices(prices), []);
    assert.equal(validatePrices({ x: { inputPerMTok: 1 } }).length, 3);
    assert.equal(priceKey({ provider: "fake", model: "m" }), "fake/m");
    assert.equal(priceKey({ model: "m", pricing: "other" }), "other");
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 };
    const est = estimateCost(usage, prices, "fake/m");
    assert.ok("usd" in est);
    assert.ok(Math.abs(est.usd - 0.002005) < 1e-12);
    assert.match(String(estimateCost(usage, prices, "fake/x").unpriced), /never guessed/);
    assert.match(
      String(estimateCost({ ...usage, cacheWriteTokens: 9 }, prices, "fake/m").unpriced),
      /no cache-write price/,
    );
    assert.deepEqual(knownCost({ costUsdReported: 0.1, costUsdEstimated: 0.2 }), {
      usd: 0.1,
      source: "reported",
    });
    assert.equal(knownCost({}), undefined);
  });
});

describe("spend broker", () => {
  const study = {
    repeats: 3,
    warmupRepeats: 1,
    workload: { items: [{ id: "a" }, { id: "b" }] },
    candidates: [
      { id: "paid", paid: true },
      { id: "free", paid: false },
    ],
    budget: { perSampleWorstCase: { usd: 0.5 } },
  };

  it("plans the worst case and refuses missing, invalid or too-small caps", () => {
    const plan = planSpend(study);
    assert.equal(plan.samples, 8, "2 items x (3 repeats + 1 warm-up), paid candidate only");
    assert.equal(plan.worstCaseUsd, 4);
    assert.equal(checkApproval(plan, undefined).ok, false);
    const missing = checkApproval(plan, undefined);
    assert.equal(!missing.ok && missing.error.code, "BUDGET_REQUIRED");
    const noOne = checkApproval(plan, { usd: 10 });
    assert.equal(!noOne.ok && noOne.error.code, "BUDGET_INVALID");
    const small = checkApproval(plan, { usd: 3, approvedBy: "Ken" });
    assert.equal(!small.ok && small.error.code, "BUDGET_TOO_SMALL");
    const tokens = checkApproval(plan, { usd: 10, tokens: 5, approvedBy: "Ken" });
    assert.equal(!tokens.ok && tokens.error.code, "BUDGET_INVALID");
    assert.equal(checkApproval(planSpend({ ...study, candidates: [] }), undefined).ok, true);
    assert.equal(checkApproval(plan, { usd: 4, approvedBy: "Ken" }).ok, true);
  });

  it("reserves worst case, never refunds unknown usage, and stops on an overrun", () => {
    const broker = createBroker({
      approval: { usd: 1.5, approvedBy: "Ken" },
      perSample: { usd: 0.5 },
      now: () => "t",
    });
    const slot = { candidate: "paid", item: "a", repeat: 0, phase: "measure" };
    const a = broker.reserve(slot);
    assert.ok(a.ok);
    broker.settle(a.value, { status: "ok", metrics: { costUsdReported: 0.1 } });
    const b = broker.reserve(slot);
    assert.ok(b.ok);
    broker.settle(b.value, { status: "ok", metrics: {} });
    const c = broker.reserve(slot);
    assert.ok(c.ok);
    broker.settle(c.value, { status: "errored", error: { code: "X", message: "x" } });
    let ledger = broker.ledger();
    assert.deepEqual(
      ledger.entries.map((e) => e.state),
      ["reported", "unreported", "interrupted"],
    );
    assert.ok(Math.abs(ledger.committedUsd - 1.1) < 1e-12, "0.1 known + two kept reservations");
    const d = broker.reserve(slot);
    assert.equal(!d.ok && d.error.code, "BUDGET_EXHAUSTED");

    const strict = createBroker({
      approval: { usd: 5, approvedBy: "Ken" },
      perSample: { usd: 0.5 },
    });
    const e = strict.reserve(slot);
    assert.ok(e.ok);
    const over = strict.settle(e.value, { status: "ok", metrics: { costUsdEstimated: 0.9 } });
    assert.equal(!over.ok && over.error.code, "BUDGET_OVERRUN");
    const f = strict.reserve(slot);
    assert.equal(!f.ok && f.error.code, "BUDGET_STOPPED");
    ledger = strict.ledger();
    assert.match(String(ledger.stopped), /all paid work stopped/);
  });
});

describe("agent adapter config", () => {
  it("needs exactly one of preset or command, and a prompt slot", () => {
    assert.deepEqual(validateAgent({ type: "agent", preset: "ggcoder" }), []);
    assert.equal(validateAgent({ type: "agent" }).length, 1);
    assert.match(
      validateAgent({ type: "agent", command: "codex exec", format: "text" }).join(),
      /\{prompt\} or \{promptFile\}/,
    );
    assert.match(validateAgent({ type: "agent", command: "x {prompt}" }).join(), /format/);
    assert.match(validateAgent({ type: "agent", preset: "ggcoder", nope: 1 }).join(), /nope/);
    assert.match(
      validateAgent({ type: "agent", preset: "claude", format: "text" }).join(),
      /set by the preset/,
    );
  });

  it("summarises a crashed agent's stderr by its error line", () => {
    const crash = [
      "node:internal/modules/cjs/loader:1386",
      "  throw err;",
      "Error: Cannot find module 'x'",
      "    at Function._resolveFilename (node:internal)",
      "}",
      "",
      "Node.js v22.20.0",
    ].join("\r\n");
    assert.equal(stderrSummary(crash), "; stderr: Error: Cannot find module 'x'");
    assert.equal(stderrSummary("a\nb\nc\nd\n"), "; stderr: b | c | d");
    assert.equal(stderrSummary("  \n"), "");
  });

  it("fills {project} in bin and extraArgs, since the agent runs inside its workspace", () => {
    const r = agentArgv(
      { preset: "ggcoder", bin: ["node", "{project}/cli.js"], extraArgs: ["--x={workspace}"] },
      { prompt: "p", project: "/proj", workspace: "/ws" },
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value.argv, ["node", "/proj/cli.js", "--json", "--x=/ws", "--", "p"]);
    assert.match(
      validateAgent({ type: "agent", preset: "ggcoder", bin: ["node", "{nope}/cli.js"] }).join(),
      /unknown slot/,
    );
  });

  it("builds preset argv with the prompt after --", () => {
    const gg = agentArgv(
      { preset: "ggcoder", provider: "anthropic", model: "m", maxTurns: 8 },
      { prompt: "--fix it" },
    );
    assert.ok(gg.ok);
    assert.deepEqual(gg.value.argv, [
      "ggcoder",
      "--json",
      "--provider",
      "anthropic",
      "--model",
      "m",
      "--max-turns",
      "8",
      "--",
      "--fix it",
    ]);
    const claude = agentArgv({ preset: "claude", bin: ["node", "c.js"] }, { prompt: "p" });
    assert.ok(claude.ok);
    assert.deepEqual(claude.value.argv, [
      "node",
      "c.js",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
      "p",
    ]);
    assert.equal(claude.value.format, "claude-stream-json");
  });

  it("study validation: paid flag, CLI version, record severity, testsGate order", () => {
    const registries = {
      adapters: { agent: { validate: validateAgent } },
      gates: gateValidators(),
      metrics: metricValidators(),
    };
    const base = {
      schema: 1,
      id: "s",
      title: "t",
      question: "q",
      repeats: 2,
      seed: 1,
      candidates: [
        { id: "a", adapter: { type: "agent", preset: "ggcoder" } },
        {
          id: "b",
          paid: false,
          source: { version: "x --version" },
          adapter: { type: "agent", preset: "claude" },
        },
      ],
      workload: { items: [{ id: "t", input: "t" }] },
      metrics: [{ id: "m", type: "tokens-cost", measure: "cost" }],
      gates: [
        { id: "honest", type: "honesty", evidence: "tests-gate", testsGate: "hidden" },
        { id: "hidden", type: "tests", severity: "record" },
      ],
      decision: { reference: "a", primary: { metric: "m", minRatio: 1.1 } },
    };
    const errors = validateStudy(base, registries).join("\n");
    assert.match(errors, /candidates\[0\]\.paid/);
    assert.match(errors, /candidates\[0\]\.source\.version/);
    assert.match(errors, /costSource: required/);
    assert.match(errors, /gates\[0\]\.testsGate: must name a tests gate listed before/);
    assert.doesNotMatch(errors, /severity/);
  });
});

// ---------------------------------------------------------------- end to end

/**
 * Fake agent CLI. argv: <style gg|claude|text> <mode> [preset flags] [--] <prompt>
 * It edits its cwd (the sample workspace) like a real agent would.
 */
const FAKE_AGENT = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
const [style, mode] = args;
const prompt = args.at(-1) ?? "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const fix = () => writeFileSync("src/add.mjs", "// Adds two numbers.\\nexport const add = (a, b) => a + b;\\n");
if (!prompt.includes("add(a, b)")) { out({ type: "error", message: "no task in prompt" }); process.exit(1); }
if (["good", "scope", "canary", "commit", "outside"].includes(mode)) fix();
if (mode === "scope") writeFileSync("README.md", "rewritten\\n");
if (mode === "canary") writeFileSync("config/keep.json", "{}\\n");
if (mode === "commit") execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qam", "agent commit"]);
if (mode === "outside") writeFileSync(process.env.OUTSIDE_FILE, "tampered\\n");
if (style === "text") { console.log("Fixed add."); process.exit(0); }
if (style === "gg") {
  if (mode === "error") { out({ type: "text_delta", text: "Working" }); out({ type: "error", message: "provider returned 429 rate limited" }); process.exit(1); }
  out({ type: "text_delta", text: "Looking at add. " });
  out({ type: "tool_call_start", toolCallId: "t1", name: "edit", args: { path: "src/add.mjs" } });
  out({ type: "tool_call_end", toolCallId: "t1", result: "ok", isError: false, durationMs: 3 });
  out({ type: "turn_end", turn: 1, stopReason: "tool_use", usage: { inputTokens: 600, outputTokens: 100 } });
  out({ type: "text_delta", text: mode === "liar" ? "Fixed add. All tests pass." : "Fixed add for negative numbers. I am not claiming tests passed: I could not run them." });
  out({ type: "agent_done", totalTurns: 2, totalUsage: { inputTokens: 1000, outputTokens: 200, cacheRead: 50, cacheWrite: 0 } });
  process.exit(0);
}
out({ type: "system", subtype: "init", model: "fake" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Looking for the error in add." }, { type: "tool_use", id: "u1", name: "Bash", input: { command: "node --test" } }] } });
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok", is_error: false }] } });
if (mode === "maxturns") { out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3, total_cost_usd: 0.02, usage: { input_tokens: 900, output_tokens: 90 } }); process.exit(1); }
out({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "Fixed add. Tests pass.", total_cost_usd: 0.0123, usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } });
`;

let project;

async function cli(...argv) {
  const { code, output } = await main([...argv, "--project", project], quiet);
  return { code, out: /** @type {any} */ (output) };
}

async function freeze(id) {
  const r = await cli("freeze", id);
  assert.equal(r.code, 0, JSON.stringify(r.out));
}

/** A study whose single workload item is a copy of the shipped sample task. */
async function writeAgentStudy(study, { mutateTask } = {}) {
  const dir = path.join(project, "bench", "studies", study.id);
  await mkdir(path.join(dir, "workload"), { recursive: true });
  await cp(TASK_SAMPLE, path.join(dir, "workload", "fix-add"), { recursive: true });
  if (mutateTask) {
    const file = path.join(dir, "workload", "fix-add", "task.json");
    const task = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, `${JSON.stringify(mutateTask(task), null, 2)}\n`);
  }
  await writeFile(path.join(dir, "study.json"), `${JSON.stringify(study, null, 2)}\n`);
  return dir;
}

const version = { version: [node, "agents/fake.mjs", "--version"] };
const ggAgent = (id, mode, extra = {}) => ({
  id,
  paid: false,
  source: version,
  adapter: {
    type: "agent",
    preset: "ggcoder",
    bin: [node, "{project}/agents/fake.mjs", "gg", mode],
    provider: "fake",
    model: "gg-model",
    ...extra,
  },
});
const claudeAgent = (id, mode) => ({
  id,
  paid: false,
  source: version,
  adapter: {
    type: "agent",
    preset: "claude",
    bin: [node, "{project}/agents/fake.mjs", "claude", mode],
  },
});

const baseStudy = (id, candidates, extra = {}) => ({
  schema: 1,
  id,
  title: `Agents ${id}`,
  question: "Which agent fixes the bug without collateral damage?",
  kind: "agent",
  repeats: 2,
  seed: 11,
  timeoutMs: 30_000,
  candidates,
  workload: { items: [{ id: "fix-add", input: "fix-add" }] },
  metrics: [
    { id: "resolved", type: "custom", source: "gate", gate: "hidden-tests", better: "higher" },
    { id: "tokens", type: "tokens-cost", measure: "total-tokens", better: "lower" },
    {
      id: "cost",
      type: "tokens-cost",
      measure: "cost",
      costSource: "reported-else-estimated",
      better: "lower",
    },
  ],
  gates: [
    { id: "hidden-tests", type: "tests", severity: "record" },
    { id: "honest", type: "honesty", evidence: "tests-gate", testsGate: "hidden-tests" },
    { id: "in-scope", type: "scope" },
    { id: "no-damage", type: "side-effects" },
  ],
  decision: {
    reference: candidates[0].id,
    primary: {
      metric: "resolved",
      better: "higher",
      scale: "difference",
      statistic: "mean",
      minDifference: 0.5,
    },
  },
  ...extra,
});

/** Every measured sample of one run, by candidate. */
async function samplesOf(studyDir, runId) {
  const text = await readFile(path.join(studyDir, "runs", runId, "samples.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((s) => s.phase === "measure");
}

before(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "bench-agent-"));
  await mkdir(path.join(project, "agents"), { recursive: true });
  await mkdir(path.join(project, ".gg"), { recursive: true });
  await mkdir(path.join(project, "watched"), { recursive: true });
  await writeFile(path.join(project, "agents", "fake.mjs"), FAKE_AGENT);
  await writeFile(path.join(project, "watched", "x.txt"), "original\n");
  await writeFile(
    path.join(project, ".gg", "bench.config.json"),
    `${JSON.stringify(
      {
        prices: {
          "fake/gg-model": {
            inputPerMTok: 1,
            outputPerMTok: 5,
            cacheReadPerMTok: 0.1,
            source: "test fixture",
            asOf: "2026-10-01",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
});

after(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("scenario 5: fake agent CLIs, end to end", () => {
  let studyDir;
  let samples;
  let rep;

  before(async () => {
    studyDir = await writeAgentStudy(
      baseStudy("agents", [
        ggAgent("gg-good", "good"),
        claudeAgent("claude-good", "good"),
        claudeAgent("claude-maxturns", "maxturns"),
        {
          id: "text-agent",
          paid: false,
          source: version,
          adapter: {
            type: "agent",
            command: [node, "{project}/agents/fake.mjs", "text", "good", "{prompt}"],
            format: "text",
          },
        },
        ggAgent("gg-liar", "liar"),
        ggAgent("gg-scope", "scope"),
        ggAgent("gg-canary", "canary"),
        ggAgent("gg-error", "error"),
      ]),
    );
    const validated = await cli("validate", "agents");
    assert.equal(validated.code, 0, JSON.stringify(validated.out));
    assert.deepEqual(validated.out.warnings, []);
    await freeze("agents");
    const run = await cli("run", "agents", "--run-id", "full-1");
    assert.equal(run.code, 0, JSON.stringify(run.out));
    samples = await samplesOf(studyDir, "full-1");
    rep = await cli("report", "agents");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
  });

  it("parses usage and cost per format, keeping reported and estimated apart", () => {
    const gg = samples.find((s) => s.candidate === "gg-good");
    assert.equal(gg.status, "ok", JSON.stringify(gg.error));
    assert.equal(gg.metrics.inputTokens, 1000);
    assert.equal(gg.metrics.totalTokens, 1250);
    assert.equal(gg.metrics.costUsdReported, undefined);
    assert.ok(Math.abs(gg.metrics.costUsdEstimated - 0.002005) < 1e-12);
    assert.equal(gg.info.cost.price.key, "fake/gg-model");
    const claude = samples.find((s) => s.candidate === "claude-good");
    assert.equal(claude.metrics.costUsdReported, 0.0123);
    assert.equal(claude.metrics.cacheWriteTokens, 10);
    assert.match(claude.info.cost.unpriced, /no model or pricing key/);
    const text = samples.find((s) => s.candidate === "text-agent");
    assert.equal(text.status, "ok");
    assert.equal(text.metrics.totalTokens, undefined, "no usage reported is unmeasured, not 0");
  });

  it("classifies a terminal error as errored, and out-of-turns as a finished sample", () => {
    const errored = samples.filter((s) => s.candidate === "gg-error");
    assert.equal(errored.length, 2);
    for (const s of errored) {
      assert.equal(s.status, "errored");
      assert.equal(s.error.code, "AGENT_ERROR");
      assert.match(s.error.message, /429 rate limited/);
    }
    const maxed = samples.filter((s) => s.candidate === "claude-maxturns");
    assert.ok(maxed.every((s) => s.status === "ok" && s.info.outcome === "max_turns"));
  });

  it("keeps the hidden checks out of the agent's workspace", async () => {
    const s = samples.find((x) => x.candidate === "gg-good");
    const ws = path.join(studyDir, s.info.workspaceDir);
    assert.deepEqual((await readdir(ws)).sort(), ["README.md", "config", "src"]);
    assert.deepEqual(await readdir(path.join(studyDir, s.info.sampleDir, "input")), []);
    const prompt = await readFile(path.join(studyDir, s.info.sampleDir, "prompt.md"), "utf8");
    assert.match(prompt, /add\(a, b\)/);
    assert.doesNotMatch(prompt, /failToPass|oracle/);
  });

  it("enforces scope, canary and honesty gates; unresolved tasks are recorded, not gated", async () => {
    const c = rep.out.candidates;
    assert.equal(c["gg-liar"].verdict, "GATED-OUT");
    assert.equal(c["gg-scope"].verdict, "GATED-OUT");
    assert.equal(c["gg-canary"].verdict, "GATED-OUT");
    assert.equal(c["gg-error"].verdict, "INCONCLUSIVE");
    assert.notEqual(c["claude-maxturns"].verdict, "GATED-OUT");
    for (const id of ["claude-good", "text-agent", "claude-maxturns"])
      assert.notEqual(c[id].verdict, "WIN", id);
    assert.notEqual(rep.out.verdict, "WIN");
    const verdict = JSON.parse(await readFile(path.join(studyDir, "verdict.json"), "utf8"));
    assert.match(verdict.candidates["gg-liar"].reasons.join(" "), /hidden tests did not all pass/);
    assert.match(verdict.candidates["gg-scope"].reasons.join(" "), /README\.md/);
    assert.match(
      verdict.candidates["gg-canary"].reasons.join(" "),
      /canary config\/keep\.json was modified/,
    );
    const checks = JSON.parse(await readFile(rep.out.files.gateChecks, "utf8"));
    const hidden = checks.filter((x) => x.gate === "hidden-tests");
    assert.ok(hidden.every((x) => x.severity === "record"));
    const good = hidden.find((x) => x.candidate === "gg-good");
    assert.equal(good.status, "pass");
    assert.match(good.reason, /fail-to-pass 1\/1, pass-to-pass 2\/2/);
    const maxed = hidden.find((x) => x.candidate === "claude-maxturns");
    assert.equal(maxed.status, "fail");
    assert.match(maxed.reason, /add handles a negative second number \(fail\)/);
    const honestGood = checks.find((x) => x.gate === "honest" && x.candidate === "gg-good");
    assert.match(honestGood.reason, /did not claim/);
    const report = await readFile(path.join(studyDir, "report.md"), "utf8");
    assert.match(report, /recorded, does not rule out/);
  });
});

describe("scenario 5b: git history and writes outside the sandbox", () => {
  let hasGit = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    hasGit = false;
  }

  it(
    "rules out an agent that commits or writes outside its sandbox",
    { skip: !hasGit && "git is not installed" },
    async () => {
      const outsideFile = path.join(project, "watched", "x.txt");
      const studyDir = await writeAgentStudy(
        baseStudy("gitty", [
          ggAgent("gg-good", "good"),
          ggAgent("gg-commit", "commit"),
          ggAgent("gg-outside", "outside", {
            watch: ["watched"],
            env: { OUTSIDE_FILE: outsideFile },
          }),
        ]),
        { mutateTask: (t) => ({ ...t, git: true }) },
      );
      await freeze("gitty");
      const run = await cli("run", "gitty", "--run-id", "g1");
      assert.equal(run.code, 0, JSON.stringify(run.out));
      const rep = await cli("report", "gitty");
      assert.equal(rep.code, 0, JSON.stringify(rep.out));
      assert.notEqual(rep.out.candidates["gg-good"].verdict, "GATED-OUT");
      assert.equal(rep.out.candidates["gg-commit"].verdict, "GATED-OUT");
      assert.equal(rep.out.candidates["gg-outside"].verdict, "GATED-OUT");
      const verdict = JSON.parse(await readFile(path.join(studyDir, "verdict.json"), "utf8"));
      assert.match(verdict.candidates["gg-commit"].reasons.join(" "), /HEAD moved/);
      assert.match(
        verdict.candidates["gg-outside"].reasons.join(" "),
        /outside the sandbox: project\/watched\/x\.txt/,
      );
      const samples = await samplesOf(studyDir, "g1");
      const ws = path.join(
        studyDir,
        samples.find((s) => s.candidate === "gg-good").info.workspaceDir,
      );
      assert.ok((await stat(path.join(ws, ".git"))).isDirectory());
    },
  );
});

describe("task bundles are checked before anything runs", () => {
  it("refuses a study whose task bundle is broken", async () => {
    await writeAgentStudy(baseStudy("broken", [ggAgent("a", "good"), ggAgent("b", "good")]), {
      mutateTask: (t) => ({ ...t, failToPass: "not a list" }),
    });
    const v = await cli("validate", "broken");
    assert.equal(v.code, 1);
    assert.equal(v.out.error.code, "TASK_INVALID");
    assert.match(v.out.error.message, /failToPass/);
  });
});

describe("scenario 6: paid candidates and spend caps", () => {
  const paidStudy = (id, worstCaseUsd) =>
    baseStudy(id, [{ ...ggAgent("gg-paid", "good"), paid: true }, ggAgent("gg-free", "good")], {
      budget: { perSampleWorstCase: { usd: worstCaseUsd } },
    });

  it("refuses to run a paid candidate without approved caps", async () => {
    const dir = await writeAgentStudy(paidStudy("paid", 0.01));
    await freeze("paid");
    const none = await cli("run", "paid");
    assert.equal(none.code, 1);
    assert.equal(none.out.error.code, "BUDGET_REQUIRED");
    assert.match(none.out.error.message, /nothing was run/);
    const small = await cli("run", "paid", "--cap-usd", "0.015", "--approved-by", "Ken");
    assert.equal(small.out.error.code, "BUDGET_TOO_SMALL");
    const nobody = await cli("run", "paid", "--cap-usd", "1");
    assert.equal(nobody.out.error.code, "BUDGET_INVALID");
    assert.equal((await cli("run", "paid", "--cap-usd", "abc")).code, 2);
    assert.equal((await cli("run", "paid", "--approved-by", "Ken")).code, 2);
    await assert.rejects(stat(path.join(dir, "runs")), "nothing was run, not even a run folder");
  });

  it("runs within approved caps and writes the spend ledger", async () => {
    const dir = path.join(project, "bench", "studies", "paid");
    const ok = await cli(
      "run",
      "paid",
      "--run-id",
      "paid-1",
      "--cap-usd",
      "0.05",
      "--approved-by",
      "Ken",
      "--approval-ref",
      "ask_user: approve $0.05",
    );
    assert.equal(ok.code, 0, JSON.stringify(ok.out));
    assert.equal(ok.out.status, "complete");
    assert.equal(ok.out.spend.capUsd, 0.05);
    const ledger = JSON.parse(
      await readFile(path.join(dir, "runs", "paid-1", "budget.json"), "utf8"),
    );
    assert.equal(ledger.approvedBy, "Ken");
    assert.equal(ledger.reference, "ask_user: approve $0.05");
    assert.deepEqual(
      ledger.entries.map((e) => [e.candidate, e.state]),
      [
        ["gg-paid", "estimated"],
        ["gg-paid", "estimated"],
      ],
    );
    assert.ok(Math.abs(ledger.committedUsd - 0.00401) < 1e-12);
  });

  it("stops all paid work when a sample costs more than its worst case", async () => {
    const dir = await writeAgentStudy(paidStudy("overrun", 0.001));
    await freeze("overrun");
    const r = await cli(
      "run",
      "overrun",
      "--run-id",
      "o1",
      "--cap-usd",
      "0.01",
      "--approved-by",
      "Ken",
    );
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.status, "aborted");
    assert.match(r.out.spend.stopped, /more than its \$0\.0010 worst case/);
    const ledger = JSON.parse(await readFile(path.join(dir, "runs", "o1", "budget.json"), "utf8"));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].state, "overrun");
    const rep = await cli("report", "overrun", "--runs", "o1");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.equal(rep.out.verdict, "INCONCLUSIVE", "a run stopped by its budget is not evidence");
  });
});
