import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarPlanGate,
  approvedPlanArtifactContent,
  hashPlanContent,
  hasPlanOnlyBoundary,
  isApprovedPlanArtifact,
  pendingPlanReview,
  planGateConflictCode,
  reducePlanGateMarkers,
  syncApprovedPlanSnapshotForDurability,
  type PersistedPlanReviewCheckpoint,
} from "./app-sidecar-plan-gate.js";
import { createWriteTool } from "./tools/write.js";

const NOW = "2026-08-10T12:00:00.000Z";

function checkpoint(
  overrides: Partial<PersistedPlanReviewCheckpoint> = {},
): PersistedPlanReviewCheckpoint {
  const content = overrides.content ?? "# Durable plan\n\n## Steps\n\n1. Ship it.";
  return {
    version: 1,
    checkpointId: "checkpoint-1",
    generation: 1,
    planPath: "/project/.gg/plans/durable.md",
    content,
    contentHash: hashPlanContent(content),
    state: "pending-review",
    reviewStatus: "unreviewed",
    actor: "gg-coder",
    timestamp: NOW,
    feedback: null,
    ...overrides,
  };
}

function marker(value: PersistedPlanReviewCheckpoint) {
  return { kind: "plan_gate", data: value as unknown as Record<string, unknown> };
}

describe("approved plan artifact state", () => {
  it("persists an unambiguous approval and cannot retain a logical Draft status", () => {
    const approved = approvedPlanArtifactContent(
      "# Plan\n\n**Status:** Draft\n\n## Steps\n\n1. Ship it.\n",
    );

    expect(approved).toContain("<!-- gg-plan-status: approved -->");
    expect(approved).toContain("**Status:** Approved");
    expect(approved).not.toMatch(/^\s*(?:[-*]\s*)?\*\*Status:\*\*\s*Draft\s*$/im);
    expect(isApprovedPlanArtifact(approved)).toBe(true);
  });

  it("recognizes the explicit plan-only boundary used by Roadmap contract plans", () => {
    expect(
      hasPlanOnlyBoundary(
        "- **Plan-only boundary:** Yes — implementation is prohibited in this phase\n",
      ),
    ).toBe(true);
    expect(hasPlanOnlyBoundary("- **Plan-only boundary:** No\n")).toBe(false);
  });

  it("adds machine-readable approval metadata when a plan has no Status field", () => {
    const approved = approvedPlanArtifactContent("# Plan\n\n## Steps\n\n1. Ship it.\n");

    expect(isApprovedPlanArtifact(approved)).toBe(true);
    expect(approvedPlanArtifactContent(approved)).toBe(approved);
  });
});

describe("approved plan snapshot durability", () => {
  function fsError(code: string, syscall: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: operation not permitted, ${syscall}`), {
      code,
      syscall,
    });
  }

  it("accepts the proven Windows EPERM fsync after the snapshot write", async () => {
    const sync = vi.fn(async () => {
      throw fsError("EPERM", "fsync");
    });

    await expect(syncApprovedPlanSnapshotForDurability(sync, "win32")).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledOnce();
  });

  it.each([
    ["win32", "EIO", "fsync"],
    ["win32", "EPERM", "write"],
    ["linux", "EPERM", "fsync"],
  ] as const)("does not swallow %s %s failures from %s", async (platform, code, syscall) => {
    const error = fsError(code, syscall);

    await expect(
      syncApprovedPlanSnapshotForDurability(async () => {
        throw error;
      }, platform),
    ).rejects.toBe(error);
  });
});

describe("AppSidecarPlanGate", () => {
  it("reduces persisted transitions and restores the exact immutable snapshot", () => {
    const submitted = checkpoint();
    const ready = checkpoint({ reviewStatus: "ready", actor: "ken-autopilot" });
    const restored = reducePlanGateMarkers([marker(submitted), marker(ready)]);

    expect(restored).toEqual(ready);
    expect(pendingPlanReview(restored)).toMatchObject({
      checkpointId: "checkpoint-1",
      generation: 1,
      content: submitted.content,
      contentHash: submitted.contentHash,
      reviewStatus: "ready",
    });
  });

  it("ignores malformed, hash-mismatched, and older-generation markers", () => {
    const current = checkpoint({ checkpointId: "checkpoint-2", generation: 2 });
    const corrupt = checkpoint({
      checkpointId: "checkpoint-3",
      generation: 3,
      contentHash: "0".repeat(64),
    });
    expect(
      reducePlanGateMarkers([
        marker(current),
        marker(checkpoint()),
        marker(corrupt),
        { kind: "task", data: {} },
      ]),
    ).toEqual(current);
  });

  it("submits increasing generations and durably supersedes the old checkpoint", async () => {
    const persisted: PersistedPlanReviewCheckpoint[] = [];
    let id = 0;
    const gate = new AppSidecarPlanGate(
      [],
      async (value) => {
        persisted.push(structuredClone(value));
      },
      () => `checkpoint-${++id}`,
      () => NOW,
    );
    const first = await gate.submit("/plan-1.md", "first");
    const second = await gate.submit("/plan-2.md", "second");

    expect(first.generation).toBe(1);
    expect(second).toMatchObject({ checkpointId: "checkpoint-2", generation: 2 });
    expect(persisted).toEqual([
      first,
      second,
      { ...first, state: "superseded", actor: "gg-coder", timestamp: NOW },
    ]);
    expect(gate.pending()?.content).toBe("second");
  });

  it("keeps plan mode write-protected when exit_plan checkpoint persistence rejects", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const submitIndex = source.indexOf(
      "const checkpoint = await planGate.submit(planPath, content);",
    );
    const disableIndex = source.indexOf("await created.setPlanMode(false);", submitIndex);
    expect(submitIndex).toBeGreaterThanOrEqual(0);
    expect(disableIndex).toBeGreaterThan(submitIndex);

    const planModeRef = { current: true };
    const persist = vi.fn(async () => {
      throw new Error("approval persistence rejected");
    });
    const gate = new AppSidecarPlanGate(
      [],
      persist,
      () => "checkpoint-regression",
      () => NOW,
    );
    const exitPlan = async () => {
      const checkpoint = await gate.submit("/plan.md", "# Plan\n\n## Steps\n\n1. Test");
      planModeRef.current = false;
      return checkpoint;
    };

    await expect(exitPlan()).rejects.toThrow("approval persistence rejected");
    expect(planModeRef.current).toBe(true);
    expect(gate.current()).toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);

    const writeTool = createWriteTool(process.cwd(), undefined, undefined, planModeRef);
    const result = await writeTool.execute(
      { file_path: "src/should-not-write.ts", content: "export {};\n" },
      { signal: new AbortController().signal, toolCallId: "exit-plan-regression" },
    );
    expect(String(result)).toContain("write is restricted in plan mode");
  });

  it("approves the persisted snapshot instead of caller paths or later file bytes", async () => {
    let diskContent = "original reviewed plan";
    const persisted: PersistedPlanReviewCheckpoint[] = [];
    const gate = new AppSidecarPlanGate(
      [],
      async (value) => {
        persisted.push(structuredClone(value));
      },
      () => "opaque-checkpoint",
      () => NOW,
    );
    const submitted = await gate.submit("/caller/can/change.md", diskContent);
    diskContent = "substituted after review";
    const approved = await gate.approve(submitted.checkpointId, submitted.generation);

    expect(approved).toMatchObject({
      status: "committed",
      checkpoint: {
        content: "original reviewed plan",
        contentHash: hashPlanContent("original reviewed plan"),
      },
    });
    expect(persisted.at(-1)?.content).not.toBe(diskContent);
  });

  it("retries an already committed human approval without persisting a second approval", async () => {
    const approved = checkpoint({ state: "human-approved", actor: "user" });
    const persist = vi.fn(async () => undefined);
    const gate = new AppSidecarPlanGate([marker(approved)], persist);

    await expect(gate.approve(approved.checkpointId, approved.generation)).resolves.toMatchObject({
      status: "committed",
      checkpoint: approved,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["implementation-prompt-started", "completed"] as const)(
    "clears a matching approval after its consumption reaches %s",
    async (state) => {
      const approved = checkpoint({ state: "human-approved", actor: "user" });
      const gate = new AppSidecarPlanGate([marker(approved)], vi.fn());

      expect(
        await gate.clearConsumed({
          checkpointId: approved.checkpointId,
          generation: approved.generation,
          state,
        }),
      ).toBe(true);
      expect(gate.current()).toBeNull();
      expect(planGateConflictCode(gate.current())).toBeNull();
    },
  );

  it("preserves pending, unconsumed, and mismatched approvals", async () => {
    const pending = checkpoint();
    const pendingGate = new AppSidecarPlanGate([marker(pending)], vi.fn());
    expect(
      await pendingGate.clearConsumed({
        checkpointId: pending.checkpointId,
        generation: pending.generation,
        state: "implementation-prompt-started",
      }),
    ).toBe(false);
    expect(pendingGate.current()).toEqual(pending);

    const approved = checkpoint({ state: "human-approved", actor: "user" });
    const approvedGate = new AppSidecarPlanGate([marker(approved)], vi.fn());
    expect(
      await approvedGate.clearConsumed({
        checkpointId: approved.checkpointId,
        generation: approved.generation,
        state: "approval-committed",
      }),
    ).toBe(false);
    expect(
      await approvedGate.clearConsumed({
        checkpointId: "other",
        generation: approved.generation,
        state: "completed",
      }),
    ).toBe(false);
    expect(approvedGate.current()).toEqual(approved);
  });

  it("serializes approve-vs-revise so exactly one compare-and-swap wins", async () => {
    const submitted = checkpoint();
    const persisted: PersistedPlanReviewCheckpoint[] = [];
    const gate = new AppSidecarPlanGate([marker(submitted)], async (value) => {
      await Promise.resolve();
      persisted.push(value);
    });

    const [approved, revised] = await Promise.all([
      gate.approve(submitted.checkpointId, submitted.generation),
      gate.requestRevision(submitted.checkpointId, submitted.generation, "ken-autopilot", "Revise"),
    ]);

    expect([approved.status, revised.status].sort()).toEqual(["committed", "conflict"]);
    expect(persisted).toHaveLength(1);
    expect(gate.current()?.state).toBe("human-approved");
  });

  it("rejects stale checkpoint identity and generation transitions", async () => {
    const submitted = checkpoint({ generation: 4 });
    const gate = new AppSidecarPlanGate([marker(submitted)], async () => undefined);

    await expect(gate.approve("other", 4)).resolves.toMatchObject({ status: "conflict" });
    await expect(gate.approve(submitted.checkpointId, 3)).resolves.toMatchObject({
      status: "conflict",
    });
    expect(gate.pending()).not.toBeNull();
  });

  it.each(["plain prompt", "/compare", "/trace", "/parity", "/ship"])(
    "rejects %s before ordinary prompt handling while approval is pending",
    () => {
      expect(planGateConflictCode(checkpoint())).toBe("plan-approval-required");
    },
  );

  it("returns the typed revision conflict until exit_plan submits a new generation", () => {
    expect(planGateConflictCode(checkpoint({ state: "revision-requested" }))).toBe(
      "plan-revision-pending",
    );
    expect(planGateConflictCode(checkpoint({ state: "human-approved" }))).toBeNull();
  });

  it("resumes the exact persisted revision after a crash without another authority marker", async () => {
    const submitted = checkpoint();
    const persisted: PersistedPlanReviewCheckpoint[] = [];
    const gate = new AppSidecarPlanGate([marker(submitted)], async (value) => {
      persisted.push(structuredClone(value));
    });
    await gate.requestRevision(submitted.checkpointId, 1, "user", "  Add recovery tests  ");

    const retryPersist = vi.fn(async () => undefined);
    const restarted = new AppSidecarPlanGate(persisted.map(marker), retryPersist);
    await expect(
      restarted.requestRevision(submitted.checkpointId, 1, "user", "Add recovery tests"),
    ).resolves.toMatchObject({
      status: "committed",
      checkpoint: { state: "revision-requested", feedback: "Add recovery tests" },
    });
    expect(retryPersist).not.toHaveBeenCalled();
    await expect(
      restarted.requestRevision(submitted.checkpointId, 1, "user", "Different feedback"),
    ).resolves.toMatchObject({ status: "conflict" });
  });
});
