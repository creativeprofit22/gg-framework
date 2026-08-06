import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import type { IdealReviewStats, ReviewCoverageTracker } from "./ideal-review.js";
import type { ActivePhaseContextV1 } from "../phase-context.js";

interface ReviewInternals {
  settingsManager: { get(key: string): boolean };
  hookStats: IdealReviewStats;
  hookFileEditCounts: Map<string, number>;
  reviewCoverage: ReviewCoverageTracker;
  subAgentManager?: { completionGateMessage(): string | undefined };
  activePhaseContext?: ActivePhaseContextV1;
  getHookFollowUpMessages(): Message[] | null;
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
    expect(followUp).toContain("Run the phase completion checks now");
    expect(followUp).toContain("1. Focused tests pass");
    expect(followUp).toContain("2. Package build passes");
    expect(followUp).toContain("Do not submit final_review");
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });
});
