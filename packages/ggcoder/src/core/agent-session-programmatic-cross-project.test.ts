import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { evaluationFixtures, materializeEvaluationFixture, type EvaluationFixture } from "../test-support/programmatic-evaluation-fixtures.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./programmatic/profile.js";
import { PROGRAMMATIC_STATE_PATH, runProgrammaticScan } from "./programmatic/lifecycle.js";
import { programmaticLifecycleStateV1Schema } from "./programmatic/contracts.js";
import { readRecommendationHistory, requireRecommendationHistoryPolicy, updateRecommendationHistory } from "./programmatic/recommendation-history.js";
import { decideRecommendation, reconcileRecommendations } from "./programmatic/recommendations.js";

// The network boundary alone is scripted; discovery, reads, receipts and acceptance are real.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({ ...(await original<Record<string, unknown>>()), stream: vi.fn() }));
let cwd: string;
let restore: () => void;
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "programmatic-matrix-"));
  restore = useFakeHome(path.join(cwd, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({ accessToken: "fixture", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER });
});
afterEach(async () => { restore(); vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });

async function assess(fixture: EvaluationFixture, mode: "setup" | "configured", unreadable = false, saveHistory = false) {
  const approved = vi.fn(async (name: string, args: unknown) => !(unreadable && name === "read" && (args as { file_path?: string }).file_path === "inspect.sh"));
  const review = vi.fn();
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: !saveHistory, mcpEnabled: false,
    approveToolExecution: approved, reviewProgrammaticSetup: review });
  let turn = 0;
  let presentation = "";
  let submitted: Record<string, unknown>;
  const visible: string[][] = [];
  const sources = [...new Set(fixture.needs.flatMap((need) => need.sources))];
  if (!sources.length) sources.push(...Object.keys(fixture.files));
  const ownerHashes = new Map<string, string>();
  for (const name of Object.keys(fixture.bodies)) ownerHashes.set(name, hash(`project:${await fs.realpath(path.join(cwd, `.gg/commands/${name}.md`))}`));
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    visible.push((params.tools ?? []).map((tool) => tool.name));
    expect(JSON.stringify(params.messages)).not.toContain("EXCLUDED_PRIVATE_MARKER");
    expect(JSON.stringify(params.messages)).not.toContain("EXCLUDED_DEPENDENCY_MARKER");
    const results = params.messages.flatMap((message) => message.role === "tool" ? message.content : []);
    const result = (id: string) => results.find((item) => item.toolCallId === id)!;
    const output = (id: string) => String(result(id).content);
    let calls: ToolCall[];
    if (++turn === 1) calls = [
      ...sources.map((file): ToolCall => ({ type: "tool_call", id: file, name: "read", args: { file_path: file } })),
      ...Object.keys(fixture.bodies).map((name): ToolCall => ({ type: "tool_call", id: name, name: "command_information", args: { action: "resolve", command: { version: 1, name, source: "project-custom", invocationKind: "prompt" } } })),
    ];
    else if (turn === 2) {
      const availability = (name: string) => {
        const resolved = JSON.parse(output(name));
        expect(resolved).toMatchObject({ status: "prompt", untrusted: true, body: fixture.bodies[name], snapshot: {
          command: { version: 1, name, source: "project-custom", invocationKind: "prompt" },
          bodySha256: hash(fixture.bodies[name]!), ownerSha256: ownerHashes.get(name), helpers: [],
        } });
        return { status: "available", snapshot: resolved.snapshot };
      };
      const recommendations = fixture.needs.map((need) => {
        const requirement = { version: 1, capabilityKind: "prompt-only", desiredOutcome: need.outcome, inputs: need.sources,
          outputs: ["Read-only discrepancy report"], prerequisites: ["Current local inputs and separate review authorization"], risks: ["Incomplete source interpretation"], verificationExpectations: [need.successCheck] };
        const base = need.command ? availability(need.command) : undefined;
        const choice = need.kind === "reuse-command" ? { kind: need.kind, availability: base }
          : need.kind === "extend-command" ? { kind: need.kind, availability: base, proposedChanges: [need.successCheck], requirement }
          : need.kind === "missing-capability" ? { kind: need.kind, proposal: requirement }
          : need.kind === "manual" ? { kind: need.kind, steps: ["Review the one-off change in a separately approved turn"] }
          : { kind: need.kind, missingEvidence: ["Representative forecast, inputs and recurrence"], nextInspectionSteps: ["Obtain an operator example; do not infer frequency"] };
        return { version: 2, kind: "advisory", outcome: need.outcome, rationale: need.rationale,
          uncertainty: "Scripted claim, not measured usage or verified execution; other workflows remain uninspected",
          workflow: { trigger: need.trigger, representativeCase: need.successCheck, inputs: need.sources,
            currentProcess: [`Inspect ${need.sources.join(", ")}`, "Compare the documented procedure with the sample"], output: need.outcome,
            successCheck: need.successCheck, affectedSubproject: need.scope ? { scope: "subproject", path: need.scope } : { scope: "repository-wide" },
            mutationBoundary: "Read-only; any change or execution needs separate approval", repeatability: {
              basis: need.kind === "needs-more-evidence" ? "assumed" : "inferred", explanation: need.kind === "manual" ? "One-off only; no recurrence claimed" : "Documented trigger, not observed usage frequency" } },
          evidence: { version: 1, items: need.sources.filter((file) => !(unreadable && file === "inspect.sh")).map((file) => {
            const receipt = JSON.parse(output(file).split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]!);
            expect(receipt).toMatchObject({ id: expect.stringMatching(/^receipt-/), toolCallId: file, tool: "read", status: "retrieved", location: file });
            return { basis: "observed", source: receipt.id, code: "workflow-source", severity: "info", message: `Inspected ${file} for ${need.outcome}; not execution proof`, location: { path: file } };
          }) },
          alternatives: need.kind === "manual" || need.kind === "needs-more-evidence" ? [] : need.kind === "missing-capability" && base
            ? [{ kind: "extend-command", availability: base, reasonNotSelected: need.rationale }]
            : [{ kind: "missing-capability", reasonNotSelected: need.rationale }], choice };
      });
      if (unreadable) expect(output("inspect.sh")).toMatch(/denied|not approved|permission/i);
      submitted = { version: 2, kind: "advisory", coverage: { status: "limited", scope: fixture.coverage, reason: unreadable ? "Script inspection denied; forecasting incomplete" : "Bounded synthetic inputs; other workflows and catalog bodies uninspected" }, recommendations };
      calls = [{ type: "tool_call", id: "forged", name: "programmatic_advisory_result", args: { ...submitted, approved: true } },
        { type: "tool_call", id: "mutation", name: "write", args: { file_path: "unauthorized.txt", content: "not allowed" } }];
    } else if (turn === 3) {
      expect(result("forged").isError).toBe(true);
      expect(result("mutation").isError).toBe(true);
      calls = [{ type: "tool_call", id: "accepted", name: "programmatic_advisory_result", args: submitted! }];
    } else {
      expect(result("accepted").isError ?? false, output("accepted")).toBe(false);
      presentation = output("accepted");
      return { message: { role: "assistant", content: "Scripted assessment ended." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    for (const call of calls) yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
    return { message: { role: "assistant", content: calls }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize();
    const commands = await fs.readdir(path.join(cwd, ".gg/commands"), { recursive: true });
    const profile = await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json")).catch(() => null);
    const response = await session.assessProgrammatic(mode);
    expect(turn).toBe(4);
    expect(response.assessment.status).toBe("completed");
    expect(response.captured?.assessment.reportedCoverage).toMatchObject({ status: "limited", scope: fixture.coverage });
    expect(presentation).toContain("Limits:");
    expect(presentation).toContain("Advice only. Running or editing anything requires separate approval.");
    expect(presentation).toContain(fixture.coverage);
    for (const need of fixture.needs) {
      for (const text of [need.outcome, need.rationale]) expect(presentation).toContain(text);
      if (need.scope) expect(presentation).toContain(`Scope: ${need.scope}`);
    }
    const advice = submitted! as { recommendations: { evidence: { items: { source: string; location: { path: string } }[] }; choice: { kind: string }; alternatives: unknown[] }[] };
    // Full workflow, success checks, paths, alternatives and receipt provenance
    // remain exact in accepted data, not raw internals recited in display copy.
    expect(response.discoveryRecords?.map((record) => record.recommendation)).toEqual(advice.recommendations);
    expect(advice.recommendations.map((need) => need.choice.kind)).toEqual(fixture.needs.map((need) => need.kind));
    advice.recommendations.forEach((need, index) => {
      expect(need.evidence.items.map((item) => item.location.path)).toEqual(fixture.needs[index]!.sources.filter((file) => !(unreadable && file === "inspect.sh")));
      for (const item of need.evidence.items) expect(presentation).not.toContain(item.source);
      if (!["manual", "needs-more-evidence"].includes(need.choice.kind)) expect(need.alternatives.length).toBeGreaterThan(0);
    });
    for (const tools of visible) for (const name of ["write", "edit", "bash", "programmatic_command", "subagent", "spawn_agent"]) expect(tools).not.toContain(name);
    expect(review).not.toHaveBeenCalled();
    expect(approved.mock.calls.filter(([name]) => name === "programmatic_scan")).toHaveLength(mode === "setup" ? 0 : 1);
    if (mode === "configured") expect(response.assessment.deterministic).toMatchObject({ status: "succeeded", enabledCount: 0, applicableCount: 0 });
    else await expect(fs.access(path.join(cwd, PROGRAMMATIC_STATE_PATH))).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json")).catch(() => null)).toEqual(profile);
    expect(await fs.readdir(path.join(cwd, ".gg/commands"), { recursive: true })).toEqual(commands);
    await expect(fs.access(path.join(cwd, "unauthorized.txt"))).rejects.toThrow();
    return response;
  } finally { await session.dispose(); }
}

it.each(evaluationFixtures.flatMap((fixture) => (["setup", "configured"] as const).map((mode) => ({ fixture, mode }))))("accepts bounded $fixture.id discovery in $mode without scanners", async ({ fixture, mode }) => {
  const files = await materializeEvaluationFixture(cwd, fixture);
  const proposal = await buildProgrammaticProfileProposal(cwd);
  expect(proposal.profile.scanners).toHaveLength(0);
  if (mode === "configured") expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  await assess(fixture, mode);
  for (const [file, bytes] of files) expect(await fs.readFile(path.join(cwd, file), "utf8")).toBe(bytes);
});

it("retains limited coverage and uncertainty when a manifest-free script cannot be inspected", async () => {
  const fixture = evaluationFixtures.find((item) => item.id === "manifest-free")!;
  await materializeEvaluationFixture(cwd, fixture);
  await assess(fixture, "setup", true);
});

it("preserves terminal recommendation and scanner history through an accepted zero-scanner no-op", async () => {
  const fixture = evaluationFixtures.find((item) => item.id === "no-new-automation")!;
  await materializeEvaluationFixture(cwd, fixture);
  // Establish scanner records through the real owner, then disable its scanner in the disposable approved profile.
  await fs.mkdir(path.join(cwd, "src-tauri"));
  await fs.writeFile(path.join(cwd, "package.json"), '{"name":"historical-scanner-fixture"}');
  await fs.writeFile(path.join(cwd, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
  await fs.writeFile(path.join(cwd, "src-tauri/tauri.conf.json"), '{"identifier":"dev.fixture"}');
  let proposal = await buildProgrammaticProfileProposal(cwd, { offerHistory: true });
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile, { expectedPriorProfileDigest: proposal.expectedPriorProfileDigest, historyPolicy: proposal.historyPolicy, expectedRecoveryDigest: proposal.expectedRecoveryDigest })).ok).toBe(true);
  expect((await runProgrammaticScan(cwd)).ok).toBe(true);
  const state = programmaticLifecycleStateV1Schema.parse(JSON.parse(await fs.readFile(path.join(cwd, PROGRAMMATIC_STATE_PATH), "utf8")));
  expect(state.records.length).toBeGreaterThan(0);
  state.records[0]!.lifecycle.state = "completed";
  const dismissed = structuredClone(state.records[0]!);
  dismissed.opportunity.identity.id = "f".repeat(64); dismissed.lifecycle.opportunity.id = dismissed.opportunity.identity.id; dismissed.lifecycle.state = "dismissed";
  state.records.push(dismissed); state.records.sort((a, b) => a.opportunity.identity.id.localeCompare(b.opportunity.identity.id));
  await fs.writeFile(path.join(cwd, PROGRAMMATIC_STATE_PATH), JSON.stringify(programmaticLifecycleStateV1Schema.parse(state)));
  await fs.rm(path.join(cwd, "src-tauri"), { recursive: true });
  await fs.rm(path.join(cwd, "package.json"));
  proposal = await buildProgrammaticProfileProposal(cwd, { offerHistory: true });
  expect(proposal.profile.scanners).toHaveLength(0);
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile, { expectedPriorProfileDigest: proposal.expectedPriorProfileDigest, historyPolicy: proposal.historyPolicy, expectedRecoveryDigest: proposal.expectedRecoveryDigest })).ok).toBe(true);
  const digest = hash(await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json")));
  const at = "2026-09-17T00:00:00.000Z";
  const seeded = await updateRecommendationHistory(cwd, (root) => requireRecommendationHistoryPolicy(root, digest), (history) => {
    const next = reconcileRecommendations(history, { assessment: { version: 1, id: randomUUID(), startedAt: at, finishedAt: at, mode: "configured", outcome: "completed", hostCoverage: [] }, observations: ["completed", "dismissed"].map((decision) => ({ version: 1, outcome: `Previous ${decision} review`, rationale: "Earlier bounded review", uncertainty: "Historical only", workflow: { trigger: `Earlier ${decision} request`, representativeCase: "Archived note", inputs: ["README.md"], currentProcess: ["Review note"], output: "Review report", successCheck: "Compare note", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read only", repeatability: { basis: "inferred", explanation: "Earlier example, not frequency" } }, choice: { kind: "manual", steps: ["Review separately"] }, alternatives: [], evidence: [] })) }).history;
    let decided = next;
    for (const [index, decision] of (["completed", "dismissed"] as const).entries()) decided = decideRecommendation(decided, { candidateId: next.candidates[index]!.id, expectedRevision: 1, decision }, at);
    return { ...decided, revision: history.revision + 1 };
  });
  const response = await assess(fixture, "configured", false, true);
  expect(response.assessment.history?.status).toBe("saved");
  const saved = await readRecommendationHistory(cwd);
  expect(saved.status).toBe("ready");
  if (saved.status !== "ready") throw new Error("Expected saved no-op coverage");
  expect(saved.history.observations).toEqual(seeded.history.observations);
  expect(saved.history.decisions).toEqual(seeded.history.decisions);
  expect(saved.history.candidates).toEqual(seeded.history.candidates);
  expect(saved.history.assessments).toHaveLength(2);
  const after = programmaticLifecycleStateV1Schema.parse(JSON.parse(await fs.readFile(path.join(cwd, PROGRAMMATIC_STATE_PATH), "utf8")));
  expect(after.records.map((record) => record.lifecycle.state).sort()).toEqual(["completed", "dismissed"]);
  expect(after.records.map((record) => record.opportunity.identity.id)).toEqual(state.records.map((record) => record.opportunity.identity.id));
});
