import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import type { IdealReviewStats, ReviewCoverageTracker } from "./ideal-review.js";
import type { ActivePhaseContextV1 } from "../phase-context.js";
import { roadmapCriterionId } from "./verification-evidence.js";

interface ReviewInternals {
  settingsManager: { get(key: string): boolean };
  hookStats: IdealReviewStats;
  hookFileEditCounts: Map<string, number>;
  reviewCoverage: ReviewCoverageTracker;
  subAgentManager?: { completionGateMessage(): string | undefined };
  activePhaseContext?: ActivePhaseContextV1;
  getHookFollowUpMessages(): Message[] | null;
  refreshIdealReviewArmed(): void;
  eventBus: AgentSession["eventBus"];
  setIdealReviewSuppressed(suppressed: boolean): void;
}

// Coverage is filesystem-backed: a changed file must still exist to be gated,
// so these fixtures live in a real temp workspace.
const workspaces: string[] = [];
function makeWorkspace(files: readonly string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "gg-review-coverage-"));
  workspaces.push(root);
  for (const file of files) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export const value = 1;\n");
  }
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

function makeReviewSession(cwd: string, changedFiles: readonly string[]): ReviewInternals {
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd,
    transient: true,
    systemPrompt: "test",
  });
  const internal = session as unknown as ReviewInternals;
  internal.settingsManager = { get: () => true };
  internal.hookStats = {
    changedLines: 130,
    toolCalls: 9,
    toolFailures: 0,
    turns: 3,
    writeCalls: 1,
    editCalls: 3,
    bashCalls: 1,
  };
  for (const file of changedFiles) internal.hookFileEditCounts.set(file, 1);
  return internal;
}

describe("AgentSession Ideal review coverage gate", () => {
  it("repeats fail-closed follow-ups until every post-injection changed file is read", () => {
    const cwd = makeWorkspace(["src/a.ts", "src/b.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);

    // A pre-review read and a model-authored claim cannot satisfy the gate.
    internal.reviewCoverage.recordRead("src/a.ts");
    const first = internal.getHookFollowUpMessages();
    expect(first?.[0]?.content).toContain("Ideal?");
    expect(first?.[0]?.content).toContain("- src/a.ts");
    const missingA = internal.getHookFollowUpMessages();
    expect(missingA?.[0]?.content).toContain("- src/a.ts");

    // A successful review-time edit expands expected coverage.
    internal.reviewCoverage.recordChanged("src/b.ts");
    internal.reviewCoverage.recordRead("src/a.ts");
    const missingB = internal.getHookFollowUpMessages();
    expect(missingB?.[0]?.content).toContain("- src/b.ts");

    internal.reviewCoverage.recordRead(path.join(cwd, "src/b.ts"));
    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });

  it("stops gating a changed file the run deleted before review", () => {
    // The observed loop: a scratch script was created, deleted, and then gated
    // forever because a deleted file can never produce read evidence.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts", "scripts/probe-many.mjs"]);

    const first = internal.getHookFollowUpMessages();
    expect(first?.[0]?.content).toContain("- src/a.ts");
    expect(first?.[0]?.content).not.toContain("probe-many.mjs");

    internal.reviewCoverage.recordRead("src/a.ts");
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });

  it("escalates to report-what-you-could-not-verify after two coverage follow-ups", () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);

    // The agent never reads the file: without a budget this repeats forever.
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("Ideal?");
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("coverage is incomplete");
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("coverage is incomplete");

    const escalation = internal.getHookFollowUpMessages()?.[0]?.content;
    expect(escalation).toContain("could not verify");
    expect(escalation).toContain("do not repeat your previous answer");
    expect(escalation).toContain("- src/a.ts");

    // Terminal: the gate is closed even though the file was never read.
    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });

  it("suppresses only Ideal review while Ken owns autopilot verification", () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd,
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.hookStats = {
      changedLines: 130,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    };
    internal.hookFileEditCounts.set("src/a.ts", 1);

    session.setIdealReviewSuppressed(true);
    expect(internal.getHookFollowUpMessages()).toBeNull();

    session.setIdealReviewSuppressed(false);
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("Ideal?");
  });

  it("arms before the draft streams and disarms only after the review hook fires", () => {
    // Arming is what lets a client hold the candidate final answer back instead
    // of painting a draft the review then deletes, so both edges must fire — and
    // disarm MUST trail the hook, or the client releases the draft into the
    // transcript one render before the hook removes it again.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const seen: string[] = [];
    internal.eventBus.on("hook_armed", (d) => seen.push(`armed:${d.armed}`));
    internal.eventBus.on("hook", (d) => seen.push(`hook:${d.kind}`));

    internal.refreshIdealReviewArmed();
    expect(seen).toEqual(["armed:true"]);
    // Only edges are broadcast, not every stat update.
    internal.refreshIdealReviewArmed();
    expect(seen).toEqual(["armed:true"]);

    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("Ideal?");
    // Still armed after the hook: coverage is outstanding, so a stop right now
    // injects again and the next candidate answer is another draft. Disarm only
    // lands once the read evidence is complete.
    expect(seen).toEqual(["armed:true", "hook:ideal"]);

    internal.reviewCoverage.recordRead("src/a.ts");
    internal.refreshIdealReviewArmed();
    expect(seen).toEqual(["armed:true", "hook:ideal", "armed:false"]);
  });

  it("announces the coverage follow-up so the draft it replaces is never painted", () => {
    // The duplicate-final-answer bug: the coverage retry injected silently, so
    // clients had nothing to hold or discard and painted the pre-coverage answer
    // on top of the reviewed one.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const seen: string[] = [];
    internal.eventBus.on("hook_armed", (d) => seen.push(`armed:${d.armed}`));
    internal.eventBus.on("hook", (d) => seen.push(`hook:${d.kind}`));

    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("Ideal?");
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("coverage is incomplete");
    // Arming lands after the hook here only because nothing computed it earlier
    // in this test; what matters is that it is on while coverage is outstanding.
    expect(seen).toEqual(["hook:ideal", "armed:true", "hook:ideal"]);

    // Escalation is an injection too: announce, then disarm as the gate closes.
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("coverage is incomplete");
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("could not verify");
    expect(seen).toEqual([
      "hook:ideal",
      "armed:true",
      "hook:ideal",
      "hook:ideal",
      "hook:ideal",
      "armed:false",
    ]);
  });

  it("arms for a run that only crosses the gate on the draft turn's own turn_end", () => {
    // `turns` advances at turn_end, so a run sitting one point below the gate
    // would otherwise arm only AFTER the draft streamed — the appear-then-vanish
    // flash. Score here is 3 (60 changed lines + 8 tool calls + 2 mutation
    // calls) until the turn point lands, so arming must predict the crossing.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, []);
    internal.hookStats = {
      changedLines: 60,
      toolCalls: 8,
      toolFailures: 0,
      turns: 5,
      writeCalls: 1,
      editCalls: 1,
      bashCalls: 0,
    };
    const armed: boolean[] = [];
    internal.eventBus.on("hook_armed", (d) => armed.push(d.armed));

    internal.refreshIdealReviewArmed();
    expect(armed).toEqual([true]);

    // And the real gate does fire once that turn is counted.
    internal.hookStats.turns = 6;
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("Ideal?");
  });

  it("stays disarmed while Ken owns autopilot verification", () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const armed: boolean[] = [];

    internal.setIdealReviewSuppressed(true);
    internal.eventBus.on("hook_armed", (d) => armed.push(d.armed));
    internal.refreshIdealReviewArmed();
    expect(armed).toEqual([]);
  });

  it("prioritizes the child completion gate before Ideal review", () => {
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/project",
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.subAgentManager = {
      completionGateMessage: () => "Collect child agent recovered-child before finishing.",
    };

    expect(internal.getHookFollowUpMessages()).toEqual([
      {
        role: "user",
        content: "Collect child agent recovered-child before finishing.",
        provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      },
    ]);
  });

  it("steers an implementing active phase through verification exactly once", () => {
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/project",
      transient: true,
      selfCorrectionHooks: false,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.activePhaseContext = {
      version: 1,
      projectKey: "/project",
      phase: {
        id: "phase-active",
        title: "Verification handoff",
        goal: "Verify before review",
        doneWhen: ["Focused tests pass", "Package build passes"],
        sourcePrompt: "Implement the phase",
        status: "in-progress",
        archivedAt: null,
      },
      session: { sessionId: "session-active", sessionPath: "/sessions/active.jsonl" },
      references: [],
      executionStage: "implementing",
    };

    const followUp = internal.getHookFollowUpMessages()?.[0]?.content;
    expect(followUp).toContain("Run one bounded check per Done When criterion");
    expect(followUp).toContain(
      `${roadmapCriterionId(1, "Focused tests pass")} — Focused tests pass`,
    );
    expect(followUp).toContain(
      `${roadmapCriterionId(2, "Package build passes")} — Package build passes`,
    );
    expect(followUp).toContain(
      'roadmap_status with transition: "done" is the only public completion-intent API',
    );
    expect(followUp).toContain("Settlement is host-only");
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });
});
