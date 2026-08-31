import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalProjectKey } from "@kenkaiiii/gg-core";
import type { PhaseLeaseRequestV2 } from "@kenkaiiii/gg-core/phase-binding-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PHASE_LEASE_TTL_MS,
  RoadmapPhaseLeaseRepository,
  type PhaseLeaseContext,
  type RoadmapPhaseLeaseHolderV1,
  type PhaseLeaseLiveness,
} from "./roadmap-phase-lease-repository.js";

let agentDir: string;
let cwd: string;
let now: number;
let liveness: PhaseLeaseLiveness;
let id: number;
let context: PhaseLeaseContext;

const holderA: RoadmapPhaseLeaseHolderV1 = {
  daemonInstanceId: "daemon-a",
  sessionId: "session-a",
  sessionPath: "/sessions/a.jsonl",
  processId: 101,
  processStartToken: "start-a",
};
const holderB: RoadmapPhaseLeaseHolderV1 = {
  daemonInstanceId: "daemon-b",
  sessionId: "session-b",
  sessionPath: "/sessions/b.jsonl",
  processId: 202,
  processStartToken: "start-b",
};

function publicHolder(holder: RoadmapPhaseLeaseHolderV1) {
  return {
    daemonInstanceId: holder.daemonInstanceId,
    sessionId: holder.sessionId,
    sessionPath: holder.sessionPath,
    processId: holder.processId,
  };
}

function repository(): RoadmapPhaseLeaseRepository {
  return new RoadmapPhaseLeaseRepository(agentDir, {
    now: () => new Date(now),
    createId: () => `lease-${++id}`,
    processLiveness: async () => liveness,
  });
}

function request(
  action: PhaseLeaseRequestV2["action"],
  operationId: string,
  lease: PhaseLeaseRequestV2["lease"] = null,
): PhaseLeaseRequestV2 {
  return {
    version: 2,
    action,
    phaseId: context.phaseId,
    expectedProjectKey: context.projectKey,
    expectedRevision: context.roadmapRevision,
    planId: context.planId,
    operationId,
    lease,
  };
}

beforeEach(async () => {
  agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-phase-leases-agent-"));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-phase-leases-project-"));
  now = Date.parse("2026-08-30T10:00:00.000Z");
  liveness = "alive";
  id = 0;
  context = {
    projectKey: canonicalProjectKey(cwd),
    roadmapRevision: 10,
    phaseId: "phase-1",
    phaseStatus: "in-progress",
    planId: "plan-1",
  };
});

afterEach(async () => {
  await Promise.all([
    fs.rm(agentDir, { recursive: true, force: true }),
    fs.rm(cwd, { recursive: true, force: true }),
  ]);
});

describe("roadmap phase lease repository", () => {
  it("serializes simultaneous acquisition so one fence wins", async () => {
    const first = repository();
    const second = repository();
    const [left, right] = await Promise.all([
      first.execute({ cwd, request: request("acquire", "acquire-a"), holder: holderA, context }),
      second.execute({ cwd, request: request("acquire", "acquire-b"), holder: holderB, context }),
    ]);
    const acquired = [left, right].filter((outcome) => outcome.status === "acquired");
    const held = [left, right].filter((outcome) => outcome.status === "phase-lease-held");
    expect(acquired).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(acquired[0]).toMatchObject({ leaseRevision: 1, lease: { fence: 1 } });
  });

  it("deduplicates before mutation and rejects changed payloads", async () => {
    const leases = repository();
    const acquire = request("acquire", "same-operation");
    const first = await leases.execute({ cwd, request: acquire, holder: holderA, context });
    const duplicate = await leases.execute({
      cwd,
      request: acquire,
      holder: holderA,
      context: { ...context, roadmapRevision: context.roadmapRevision + 1 },
    });
    const conflict = await leases.execute({
      cwd,
      request: { ...acquire, planId: null },
      holder: holderA,
      context: { ...context, planId: null },
    });
    expect(first).toMatchObject({
      status: "acquired",
      leaseRevision: 1,
      lease: { holder: publicHolder(holderA) },
    });
    expect(duplicate).toMatchObject({
      status: "duplicate",
      leaseRevision: 1,
      lease: { holder: publicHolder(holderA) },
    });
    expect(JSON.stringify([first, duplicate])).not.toContain("processStartToken");
    expect(conflict).toMatchObject({ status: "operation-conflict", leaseRevision: 1 });
  });

  it("executes mutations only for the current unexpired fence", async () => {
    const leases = repository();
    const acquired = await leases.execute({
      cwd,
      request: request("acquire", "acquire-fence"),
      holder: holderA,
      context,
    });
    if (acquired.status !== "acquired" || !acquired.lease) throw new Error("expected lease");
    const leaseId = acquired.lease.leaseId;
    const fence = acquired.lease.fence;
    let mutations = 0;
    await expect(
      leases.withFence(
        { cwd, phaseId: context.phaseId, token: { leaseId, fence }, holder: holderA },
        async () => ++mutations,
      ),
    ).resolves.toEqual({ status: "executed", value: 1 });

    now += PHASE_LEASE_TTL_MS + 1;
    await expect(
      leases.withFence(
        { cwd, phaseId: context.phaseId, token: { leaseId, fence }, holder: holderA },
        async () => ++mutations,
      ),
    ).resolves.toMatchObject({ status: "phase-lease-lost" });
    expect(mutations).toBe(1);
  });

  it("fails closed for uncertain expired owners and replaces proven dead owners", async () => {
    const leases = repository();
    const acquired = await leases.execute({
      cwd,
      request: request("acquire", "acquire"),
      holder: holderA,
      context,
    });
    expect(acquired.status).toBe("acquired");
    now += PHASE_LEASE_TTL_MS + 1;
    liveness = "unknown";
    expect(
      await leases.execute({
        cwd,
        request: request("acquire", "uncertain"),
        holder: holderB,
        context,
      }),
    ).toMatchObject({ status: "lease-owner-unreachable", leaseRevision: 1 });
    liveness = "dead";
    const replacement = await leases.execute({
      cwd,
      request: request("acquire", "replacement"),
      holder: holderB,
      context,
    });
    expect(replacement).toMatchObject({
      status: "acquired",
      leaseRevision: 2,
      lease: { fence: 2, holder: publicHolder(holderB) },
    });
  });

  it("replaces a proven dead owner before its lease expires", async () => {
    const leases = repository();
    expect(
      await leases.execute({
        cwd,
        request: request("acquire", "acquire-live"),
        holder: holderA,
        context,
      }),
    ).toMatchObject({ status: "acquired", lease: { fence: 1 } });

    liveness = "dead";
    expect(
      await leases.execute({
        cwd,
        request: request("acquire", "replace-dead"),
        holder: holderB,
        context,
      }),
    ).toMatchObject({
      status: "acquired",
      leaseRevision: 2,
      lease: { fence: 2, holder: publicHolder(holderB) },
    });
  });

});
